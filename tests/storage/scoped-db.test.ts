/// <reference types="bun-types" />
/**
 * scopedDb (Drizzle) against real PostgreSQL (pglite) and SQLite (bun:sqlite).
 *
 * A scope is a filter written against the consumer's own columns. scopedDb ANDs
 * the fragment the guard activated for the request into every query that touches
 * the resource's table — select, join, update, delete — so a row the scope
 * excludes can neither be read nor written. Inserts pass through untouched, and
 * db.unscoped(reason) is the only way past the filter.
 */

import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { asc, eq } from 'drizzle-orm'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { sqliteTable, text as sqliteText } from 'drizzle-orm/sqlite-core'

import { createGuard, MisconfiguredError, Policy, Scope } from '../../src/index.js'
import type { GuardEngine, ResourceDefinition, Subject } from '../../src/index.js'
import { drizzleAdapter, scopedDb } from '../../src/storage/drizzle/index.js'
import * as pgSchema from '../../src/storage/drizzle/schema/pg.js'
import * as sqliteSchema from '../../src/storage/drizzle/schema/sqlite.js'
import { makePgDb } from './helpers/pg.js'
import { makeSqliteDb } from './helpers/sqlite.js'

// ── User tables ───────────────────────────────────────────────────────────────

/** The filtered resource. `sellerId` is the consumer's own column the scope reads. */
const sales = pgTable('sales', {
  id: text('id').primaryKey(),
  status: text('status').notNull(),
  sellerId: text('seller_id').notNull(),
})

/** Registered but never scoped — proves a filter keys on its own resource type. */
const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

const USER_DDL = `
CREATE TABLE "posts" ("id" text PRIMARY KEY, "title" text NOT NULL);
CREATE TABLE "sales" ("id" text PRIMARY KEY, "status" text NOT NULL, "seller_id" text NOT NULL);
`

// ── Harness ───────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = []

afterAll(async () => {
  await Promise.all(cleanups.map(close => close().catch(() => {})))
  cleanups.length = 0
})

const cashier: Subject = { id: 'cashier' }
const manager: Subject = { id: 'manager' }

const runAs = <T>(engine: GuardEngine, subject: Subject, fn: () => Promise<T>): Promise<T> =>
  engine.store.run(async () => {
    engine.store.setSubject(subject)
    return await fn()
  })

/** The framework guard's flow: enter context, resolve subject, authorize, store the plan. */
const runGuarded = <T>(
  engine: GuardEngine,
  subject: Subject,
  policy: string,
  resource: ResourceDefinition,
  fn: () => Promise<T>,
): Promise<T> =>
  engine.store.run(async () => {
    engine.store.setSubject(subject)
    await engine.authorize(subject, policy)
    await engine.storeFilterFor(subject, policy, resource)
    // `return await`, not `return`: under Bun, resolving the context callback
    // WITH a bare thenable subscribes to it outside the ALS frame.
    return await fn()
  })

async function makeFilterSetup() {
  const pg = await makePgDb(USER_DDL)
  cleanups.push(pg.close)

  const adapter = drizzleAdapter(pg.db, { schema: pgSchema })

  let rowsSeenDuringFilter = -1
  const auditScope = new Scope('audit-window', 'Audit window', async () => {
    const seen = await db.select().from(sales)
    rowsSeenDuringFilter = seen.length
    return true
  })
  const ownScope = new Scope('own', 'Own sales', subject => ({
    where: eq(sales.sellerId, subject.id),
  }))
  // Granted, but the scope excludes every row — the fail-closed arm.
  const windowScope = new Scope('in-window', 'In window', () => false)

  const saleResource: ResourceDefinition = {
    type: 'sale',
    policies: [
      new Policy('sales.view', { scopeOptions: [ownScope] }),
      new Policy('sales.void', { scopeOptions: [ownScope] }),
      new Policy('sales.audit', { scopeOptions: [auditScope] }),
      new Policy('sales.flag', { scopeOptions: [windowScope] }),
    ],
    table: sales,
  }
  const resources: ResourceDefinition[] = [saleResource, { type: 'post', policies: [], table: posts }]
  const rbac = createGuard({ adapter, resources, cache: false })
  cleanups.push(async () => rbac.dispose())

  const db = scopedDb(pg.db, { guard: { engine: rbac.engine }, resources, unscoped: ['test-bypass'] })

  await rbac.sync()
  await rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'sales.view')
  await rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'sales.void', 'own')
  await rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'sales.audit', 'audit-window')
  await rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'sales.flag', 'in-window')
  await rbac.admin.assignPolicy({ subjectId: 'manager' }, 'sales.view')

  await pg.db.insert(sales).values([
    { id: 's1', status: 'open', sellerId: 'cashier' },
    { id: 's2', status: 'void', sellerId: 'cashier' },
    { id: 's3', status: 'open', sellerId: 'u9' },
  ])

  return { pg, engine: rbac.engine, db, saleResource, rowsSeenDuringFilter: () => rowsSeenDuringFilter }
}

// ── Reads ─────────────────────────────────────────────────────────────────────

describe('scopedDb — a guard-activated scope narrows db.select (pg)', () => {
  test("a route guarded by the 'own'-scoped void grant sees only the subject's own rows", async () => {
    const { engine, db, saleResource } = await makeFilterSetup()

    const rows = await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.select().from(sales),
    )
    expect(rows.map(row => row.id).sort()).toEqual(['s1', 's2'])
  })

  test('the SAME subject on a route guarded by the unscoped view grant reads every row — the filter follows the exercised policy', async () => {
    const { engine, db, saleResource } = await makeFilterSetup()

    const viewRows = await runGuarded(engine, cashier, 'sales.view', saleResource, () =>
      db.select().from(sales),
    )
    expect(viewRows).toHaveLength(3)

    const voidRows = await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.select().from(sales),
    )
    expect(voidRows.map(row => row.id).sort()).toEqual(['s1', 's2'])
  })

  test("a caller's own .where() is ANDed with the scope fragment, never replaced by it", async () => {
    const { engine, db, saleResource } = await makeFilterSetup()

    const open = await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.select().from(sales).where(eq(sales.status, 'open')),
    )
    expect(open.map(row => row.id)).toEqual(['s1'])

    // s3 matches the caller's filter but not the scope — the scope must win.
    const foreign = await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.select().from(sales).where(eq(sales.id, 's3')),
    )
    expect(foreign).toEqual([])
  })

  test('builder methods chained after from() keep the fragment', async () => {
    const { engine, db, saleResource } = await makeFilterSetup()

    const rows = await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.select().from(sales).orderBy(asc(sales.id)).limit(10),
    )
    expect(rows.map(row => row.id)).toEqual(['s1', 's2'])
  })

  test('selectDistinct carries the fragment too', async () => {
    const { engine, db, saleResource } = await makeFilterSetup()

    const rows = await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.selectDistinct({ seller: sales.sellerId }).from(sales),
    )
    expect(rows.map(row => row.seller)).toEqual(['cashier'])
  })

  test('an unscoped grant leaves the query untouched', async () => {
    const { engine, db, saleResource } = await makeFilterSetup()

    const rows = await runGuarded(engine, manager, 'sales.view', saleResource, () =>
      db.select().from(sales),
    )
    expect(rows).toHaveLength(3)
  })

  test('a granted policy whose scope excludes every row yields an empty list, not an error', async () => {
    const { engine, db, saleResource } = await makeFilterSetup()

    const rows = await runGuarded(engine, cashier, 'sales.flag', saleResource, () =>
      db.select().from(sales),
    )
    expect(rows).toEqual([])
  })

  test('a subject WITHOUT a guard reads unfiltered — no static fallback exists', async () => {
    const { engine, db } = await makeFilterSetup()

    const rows = await runAs(engine, cashier, () => db.select().from(sales))
    expect(rows).toHaveLength(3)
  })

  test('a scope querying the table while building its fragment sees it UNFILTERED', async () => {
    const { engine, db, saleResource, rowsSeenDuringFilter } = await makeFilterSetup()

    await runGuarded(engine, cashier, 'sales.void', saleResource, async () => {
      await engine.filterFor(cashier, 'sales.audit', saleResource)
      expect(rowsSeenDuringFilter()).toBe(3)

      // The suppression does not leak past the scope's own evaluation.
      const after = await db.select().from(sales)
      expect(after.map(row => row.id).sort()).toEqual(['s1', 's2'])
    })
  })

  test('db.unscoped selects are never filtered', async () => {
    const { engine, db, saleResource } = await makeFilterSetup()

    const rows = await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.unscoped('test-bypass').select().from(sales),
    )
    expect(rows).toHaveLength(3)
  })

  test('with no request subject (seeders/CLI/jobs) selects are unfiltered', async () => {
    const { db } = await makeFilterSetup()

    expect(await db.select().from(sales)).toHaveLength(3)
  })

  test('the fragment keys on its own resource type — other registered tables stay unfiltered', async () => {
    const { pg, engine, db, saleResource } = await makeFilterSetup()
    await pg.db.insert(posts).values({ id: 'p1', title: 'P1' })

    const rows = await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.select().from(posts),
    )
    expect(rows).toHaveLength(1)
  })

  test('selects on unregistered tables are never filtered', async () => {
    const { pg, engine, db, saleResource } = await makeFilterSetup()
    const strangers = pgTable('strangers', { id: text('id').primaryKey() })
    await pg.client.exec('CREATE TABLE "strangers" ("id" text PRIMARY KEY)')
    await pg.db.insert(strangers).values({ id: 'x1' })

    const rows = await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.select().from(strangers),
    )
    expect(rows).toHaveLength(1)
  })
})

// ── Joins ─────────────────────────────────────────────────────────────────────

describe('scopedDb — a joined table carries its own fragment (pg)', () => {
  test("innerJoin on a filtered table applies that table's fragment", async () => {
    const { engine, db, saleResource, pg } = await makeFilterSetup()

    await pg.db.insert(posts).values([
      { id: 's1', title: 'one' },
      { id: 's2', title: 'two' },
      { id: 's3', title: 'three' },
    ])

    const rows = await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.select().from(posts).innerJoin(sales, eq(posts.id, sales.id)),
    )

    // s3 belongs to another seller — joining must not surface it.
    expect(rows.map((row: any) => row.sales.id).sort()).toEqual(['s1', 's2'])
  })

  test('leftJoin keeps its left rows and nulls the rows the scope excludes', async () => {
    const { engine, db, saleResource, pg } = await makeFilterSetup()

    await pg.db.insert(posts).values([
      { id: 's1', title: 'one' },
      { id: 's3', title: 'three' },
    ])

    const rows = await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.select().from(posts).leftJoin(sales, eq(posts.id, sales.id)).orderBy(asc(posts.id)),
    )

    expect(rows.map((row: any) => [row.posts.id, row.sales?.id ?? null])).toEqual([
      ['s1', 's1'],
      ['s3', null],
    ])
  })

  test('joining an unfiltered table is untouched', async () => {
    const { engine, db, saleResource, pg } = await makeFilterSetup()

    await pg.db.insert(posts).values([{ id: 's3', title: 'three' }])

    const rows = await runGuarded(engine, cashier, 'sales.view', saleResource, () =>
      db.select().from(sales).innerJoin(posts, eq(sales.id, posts.id)),
    )

    expect(rows.map((row: any) => row.posts.id)).toEqual(['s3'])
  })
})

// ── Writes ────────────────────────────────────────────────────────────────────

describe('scopedDb — update and delete carry the fragment select carries (pg)', () => {
  test('update on a filtered table only touches rows the scope allows', async () => {
    const { engine, db, saleResource, pg } = await makeFilterSetup()

    await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.update(sales).set({ status: 'cancelled' }),
    )

    const after = await pg.db.select().from(sales).orderBy(asc(sales.id))
    // s3 belongs to another seller — it must be untouched.
    expect(after.map(row => `${row.id}:${row.status}`)).toEqual([
      's1:cancelled',
      's2:cancelled',
      's3:open',
    ])
  })

  test("a caller's own .where() on update is ANDed with the fragment", async () => {
    const { engine, db, saleResource, pg } = await makeFilterSetup()

    await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.update(sales).set({ status: 'cancelled' }).where(eq(sales.id, 's2')),
    )

    const after = await pg.db.select().from(sales).orderBy(asc(sales.id))
    expect(after.map(row => `${row.id}:${row.status}`)).toEqual([
      's1:open',
      's2:cancelled',
      's3:open',
    ])
  })

  test('update cannot reach an excluded row even when addressed by id', async () => {
    const { engine, db, saleResource, pg } = await makeFilterSetup()

    await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.update(sales).set({ status: 'hijacked' }).where(eq(sales.id, 's3')),
    )

    const [row] = await pg.db.select().from(sales).where(eq(sales.id, 's3'))
    expect(row?.status).toBe('open')
  })

  test('delete on a filtered table only removes rows the scope allows', async () => {
    const { engine, db, saleResource, pg } = await makeFilterSetup()

    await runGuarded(engine, cashier, 'sales.void', saleResource, () => db.delete(sales))

    const after = await pg.db.select().from(sales).orderBy(asc(sales.id))
    expect(after.map(row => row.id)).toEqual(['s3'])
  })

  test('an unscoped grant leaves update untouched', async () => {
    const { engine, db, saleResource, pg } = await makeFilterSetup()

    await runGuarded(engine, manager, 'sales.view', saleResource, () =>
      db.update(sales).set({ status: 'reviewed' }),
    )

    const after = await pg.db.select().from(sales)
    expect(after.every(row => row.status === 'reviewed')).toBe(true)
  })

  test('a scope that excludes every row updates nothing rather than everything', async () => {
    const { engine, db, saleResource, pg } = await makeFilterSetup()

    await runGuarded(engine, cashier, 'sales.flag', saleResource, () =>
      db.update(sales).set({ status: 'flagged' }),
    )

    const after = await pg.db.select().from(sales)
    expect(after.some(row => row.status === 'flagged')).toBe(false)
  })

  test('updates on unregistered tables are never filtered', async () => {
    const { engine, db, saleResource, pg } = await makeFilterSetup()

    await pg.db.insert(posts).values([{ id: 'p1', title: 'one' }])
    await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.update(posts).set({ title: 'edited' }),
    )

    const [row] = await pg.db.select().from(posts).where(eq(posts.id, 'p1'))
    expect(row?.title).toBe('edited')
  })

  test('db.unscoped updates are never filtered', async () => {
    const { engine, db, saleResource, pg } = await makeFilterSetup()

    await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.unscoped('test-bypass').update(sales).set({ status: 'raw' }),
    )

    const after = await pg.db.select().from(sales)
    expect(after.every(row => row.status === 'raw')).toBe(true)
  })
})

// ── Inserts ───────────────────────────────────────────────────────────────────

describe('scopedDb — inserts pass straight through (pg)', () => {
  test('an insert on a filtered table writes the row and nothing else', async () => {
    const { engine, db, saleResource, pg } = await makeFilterSetup()
    const warn = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
        db.insert(sales).values({ id: 's4', status: 'open', sellerId: 'cashier' }),
      )

      expect(warn).not.toHaveBeenCalled()
      const after = await pg.db.select().from(sales).orderBy(asc(sales.id))
      expect(after.map(row => row.id)).toEqual(['s1', 's2', 's3', 's4'])
    } finally {
      warn.mockRestore()
    }
  })

  test('an insert whose row the scope would exclude is still written — inserts are not filtered', async () => {
    const { engine, db, saleResource, pg } = await makeFilterSetup()

    await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.insert(sales).values({ id: 's4', status: 'open', sellerId: 'someone-else' }),
    )

    const [row] = await pg.db.select().from(sales).where(eq(sales.id, 's4'))
    expect(row?.sellerId).toBe('someone-else')
  })

  test('.returning() hands back the inserted rows unchanged', async () => {
    const { engine, db, saleResource } = await makeFilterSetup()

    const returned = await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.insert(sales).values({ id: 's4', status: 'open', sellerId: 'cashier' }).returning(),
    )

    expect(returned.map(row => row.id)).toEqual(['s4'])
  })

  test('an insert inside db.transaction commits with the transaction', async () => {
    const { engine, db, saleResource, pg } = await makeFilterSetup()

    await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.transaction(async tx => {
        await tx.insert(sales).values({ id: 's4', status: 'open', sellerId: 'cashier' })
      }),
    )

    expect(await pg.db.select().from(sales)).toHaveLength(4)
  })

  test('a transaction that throws after an insert rolls the row back', async () => {
    const { engine, db, saleResource, pg } = await makeFilterSetup()

    await expect(
      runGuarded(engine, cashier, 'sales.void', saleResource, () =>
        db.transaction(async tx => {
          await tx.insert(sales).values({ id: 's4', status: 'open', sellerId: 'cashier' })
          throw new Error('boom')
        }),
      ),
    ).rejects.toThrow('boom')

    expect(await pg.db.select().from(sales)).toHaveLength(3)
  })

  test('a select inside db.transaction still carries the fragment', async () => {
    const { engine, db, saleResource } = await makeFilterSetup()

    const rows = await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.transaction(tx => tx.select().from(sales)),
    )

    expect(rows.map((row: any) => row.id).sort()).toEqual(['s1', 's2'])
  })
})

// ── unscoped allowlist ───────────────────────────────────────────────────────

describe('scopedDb — unscoped is a registered decision', () => {
  test('a reason on the allowlist hands back the raw, unfiltered handle', async () => {
    const { engine, db, saleResource } = await makeFilterSetup()

    const rows = await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.unscoped('test-bypass').select().from(sales),
    )

    expect(rows).toHaveLength(3)
  })

  test('a reason that was never registered throws instead of bypassing', async () => {
    const { db } = await makeFilterSetup()

    expect(() => db.unscoped('quick fix')).toThrow(MisconfiguredError)
  })

  test('reaching for unscoped without a reason throws', async () => {
    const { db } = await makeFilterSetup()

    expect(() => (db.unscoped as unknown as () => unknown)()).toThrow(MisconfiguredError)
  })

  test('with no allowlist configured nothing may bypass', async () => {
    const pg = await makePgDb(USER_DDL)
    cleanups.push(pg.close)
    const adapter = drizzleAdapter(pg.db, { schema: pgSchema })
    const resources: ResourceDefinition[] = [{ type: 'post', policies: [], table: posts }]
    const rbac = createGuard({ adapter, resources, cache: false })
    cleanups.push(async () => rbac.dispose())
    const db = scopedDb(pg.db, { guard: { engine: rbac.engine }, resources })

    expect(() => db.unscoped('anything')).toThrow(MisconfiguredError)
  })
})

// ── sqlite leg ────────────────────────────────────────────────────────────────

const salesLite = sqliteTable('sales', {
  id: sqliteText('id').primaryKey(),
  status: sqliteText('status').notNull(),
  sellerId: sqliteText('seller_id').notNull(),
})

const SQLITE_USER_DDL = `
CREATE TABLE sales (id text PRIMARY KEY, status text NOT NULL, seller_id text NOT NULL);
`

async function makeSqliteFilterSetup() {
  const { db: raw, sqlite } = makeSqliteDb(SQLITE_USER_DDL)
  cleanups.push(async () => sqlite.close())

  const adapter = drizzleAdapter(raw, { schema: sqliteSchema })
  const ownScope = new Scope('own', 'Own sales', subject => ({
    where: eq(salesLite.sellerId, subject.id),
  }))
  const saleResource: ResourceDefinition = {
    type: 'sale',
    policies: [
      new Policy('sales.view', { scopeOptions: [ownScope] }),
      new Policy('sales.void', { scopeOptions: [ownScope] }),
    ],
    table: salesLite,
  }
  const resources: ResourceDefinition[] = [saleResource]
  const rbac = createGuard({ adapter, resources, cache: false })
  cleanups.push(async () => rbac.dispose())

  const db = scopedDb(raw, { guard: { engine: rbac.engine }, resources, unscoped: ['test-bypass'] })

  await rbac.sync()
  await rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'sales.view')
  await rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'sales.void', 'own')
  await rbac.admin.assignPolicy({ subjectId: 'manager' }, 'sales.view')

  await raw.insert(salesLite).values([
    { id: 's1', status: 'open', sellerId: 'cashier' },
    { id: 's2', status: 'void', sellerId: 'cashier' },
    { id: 's3', status: 'open', sellerId: 'u9' },
  ])

  return { raw, engine: rbac.engine, db, saleResource }
}

describe('scopedDb — a guard-activated scope narrows db.select (sqlite)', () => {
  test("a route guarded by the 'own'-scoped void grant sees only the subject's own rows", async () => {
    const { engine, db, saleResource } = await makeSqliteFilterSetup()

    const rows = await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.select().from(salesLite),
    )
    expect(rows.map(row => row.id).sort()).toEqual(['s1', 's2'])
  })

  test("a caller's own .where() is ANDed with the fragment, including through .all()", async () => {
    const { engine, db, saleResource } = await makeSqliteFilterSetup()

    const open = await runGuarded(engine, cashier, 'sales.void', saleResource, async () =>
      db.select().from(salesLite).where(eq(salesLite.status, 'open')).all(),
    )
    expect(open.map(row => row.id)).toEqual(['s1'])
  })

  test('the same subject guarded by the unscoped view grant sees every row', async () => {
    const { engine, db, saleResource } = await makeSqliteFilterSetup()

    const rows = await runGuarded(engine, cashier, 'sales.view', saleResource, () =>
      db.select().from(salesLite),
    )
    expect(rows).toHaveLength(3)
  })

  test('a subject without a guard reads unfiltered', async () => {
    const { engine, db } = await makeSqliteFilterSetup()

    const rows = await runAs(engine, cashier, () => db.select().from(salesLite))
    expect(rows).toHaveLength(3)
  })

  test('delete carries the same fragment as select', async () => {
    const { engine, db, saleResource, raw } = await makeSqliteFilterSetup()

    await runGuarded(engine, cashier, 'sales.void', saleResource, () => db.delete(salesLite))

    const after = await raw.select().from(salesLite)
    expect(after.map(row => row.id)).toEqual(['s3'])
  })

  test('db.unscoped selects are never filtered', async () => {
    const { engine, db, saleResource } = await makeSqliteFilterSetup()

    const rows = await runGuarded(engine, cashier, 'sales.void', saleResource, () =>
      db.unscoped('test-bypass').select().from(salesLite),
    )
    expect(rows).toHaveLength(3)
  })
})
