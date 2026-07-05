/// <reference types="bun-types" />
/**
 * trackedDb (Drizzle) behavior against real PostgreSQL (pglite) and SQLite
 * (bun:sqlite) semantics: ownership auto-tracking on insert (values-ids and
 * .returning() paths), transactional atomicity, the v0 "ownership failure
 * hangs the caller" regression, strictTracking modes, db.untracked bypass,
 * and grant-driven automatic read filtering on select (filterForResource:
 * all / none / where trichotomy, inAuthz suppression).
 */

import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { asc, eq } from 'drizzle-orm'
import { pgTable, serial, text } from 'drizzle-orm/pg-core'
import { sqliteTable, text as sqliteText } from 'drizzle-orm/sqlite-core'

import { createRbac, MisconfiguredError, Policy, Scope } from '../../src/index.js'
import type { RbacEngine, ResourceDefinition, Subject } from '../../src/index.js'
import { drizzleAdapter, trackedDb } from '../../src/storage/drizzle/index.js'
import * as pgSchema from '../../src/storage/drizzle/schema/pg.js'
import * as sqliteSchema from '../../src/storage/drizzle/schema/sqlite.js'
import { makePgDb } from './helpers/pg.js'
import { makeSqliteDb } from './helpers/sqlite.js'

// ── User tables ───────────────────────────────────────────────────────────────

/** Client-generated text ids (crypto.randomUUID in values()). */
const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

/** DB-generated serial ids — unobtainable without .returning(). */
const events = pgTable('events', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
})

/** Auto-filter target: `list` declared, Scope.owned() on the grant. */
const sales = pgTable('sales', {
  id: text('id').primaryKey(),
  status: text('status').notNull(),
})

const USER_DDL = `
CREATE TABLE "posts" ("id" text PRIMARY KEY, "title" text NOT NULL);
CREATE TABLE "events" ("id" serial PRIMARY KEY, "title" text NOT NULL);
CREATE TABLE "sales" ("id" text PRIMARY KEY, "status" text NOT NULL);
`

// ── Harness ───────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<void>)[] = []

afterAll(async () => {
  await Promise.all(cleanups.map(close => close().catch(() => {})))
  cleanups.length = 0
})

async function makeSetup(options?: { strictTracking?: 'warn' | 'error' | 'off' }) {
  const pg = await makePgDb(USER_DDL)
  cleanups.push(pg.close)

  const adapter = drizzleAdapter(pg.db, { schema: pgSchema })
  const resources: ResourceDefinition[] = [
    { type: 'post', policies: [], table: posts },
    { type: 'event', policies: [], table: events },
  ]
  const rbac = createRbac({ adapter, resources, cache: false })
  cleanups.push(async () => rbac.dispose())

  const db = trackedDb(pg.db, {
    rbac: { engine: rbac.engine, adapter },
    resources,
    ...(options?.strictTracking ? { strictTracking: options.strictTracking } : {}),
  })

  return { pg, adapter, engine: rbac.engine, rbac, db }
}

const runAs = <T>(engine: RbacEngine, subject: Subject, fn: () => Promise<T>): Promise<T> =>
  engine.store.run(async () => {
    engine.store.setSubject(subject)
    return fn()
  })

const u1: Subject = { id: 'u1', domain: 'admin', tenant_id: 'c1' }

const ownershipRows = (pg: Awaited<ReturnType<typeof makePgDb>>) =>
  pg.db.select().from(pgSchema.rbacResourceOwners)

// ── (a) plain insert without .returning(): ids read from values() ────────────

describe('trackedDb — ownership tracking on insert', () => {
  test('a: plain await db.insert().values({id,...}) without .returning() records ownership from the values ids', async () => {
    const { pg, adapter, engine, db } = await makeSetup()
    const id = crypto.randomUUID()

    await runAs(engine, u1, async () => {
      await db.insert(posts).values({ id, title: 'hello' })
    })

    expect(await adapter.isOwner('u1', { type: 'post', id })).toBe(true)
    const rows = await ownershipRows(pg)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      resourceType: 'post',
      resourceId: id,
      ownerId: 'u1',
      relation: 'owner',
      domain: 'admin',
      tenantId: 'c1',
    })
  })

  test('a: multi-row values() records ownership for every id', async () => {
    const { adapter, engine, db } = await makeSetup()
    const ids = [crypto.randomUUID(), crypto.randomUUID()]

    await runAs(engine, u1, async () => {
      await db.insert(posts).values(ids.map(id => ({ id, title: `t-${id}` })))
    })

    for (const id of ids) {
      expect(await adapter.isOwner('u1', { type: 'post', id })).toBe(true)
    }
  })

  test('a: inserts into unregistered tables are untouched (no ownership rows)', async () => {
    const { pg, engine, db } = await makeSetup()
    const strangers = pgTable('strangers', { id: text('id').primaryKey() })
    await pg.client.exec('CREATE TABLE "strangers" ("id" text PRIMARY KEY)')

    await runAs(engine, u1, async () => {
      await db.insert(strangers).values({ id: 's1' })
    })

    expect(await ownershipRows(pg)).toHaveLength(0)
  })

  // ── (b) .returning() path ──────────────────────────────────────────────────

  test('b: .returning() records ownership from the returned db-generated ids', async () => {
    const { pg, adapter, engine, db } = await makeSetup()

    const returned = await runAs(engine, u1, () =>
      db.insert(events).values({ title: 'launch' }).returning(),
    )

    expect(returned).toHaveLength(1)
    const id = String(returned[0]!.id)
    expect(await adapter.isOwner('u1', { type: 'event', id })).toBe(true)
    const rows = await ownershipRows(pg)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ resourceType: 'event', resourceId: id, ownerId: 'u1' })
  })

  // ── (c) transactions: ownership is atomic with the insert ─────────────────

  test('c: tracked insert inside db.transaction commits post AND ownership together', async () => {
    const { pg, adapter, engine, db } = await makeSetup()
    const id = crypto.randomUUID()

    await runAs(engine, u1, () =>
      db.transaction(async tx => {
        await tx.insert(posts).values({ id, title: 'tx' })
      }),
    )

    expect(await pg.db.select().from(posts)).toHaveLength(1)
    expect(await adapter.isOwner('u1', { type: 'post', id })).toBe(true)
  })

  test('c: a transaction that throws after the insert rolls back BOTH the row and its ownership', async () => {
    const { pg, adapter, engine, db } = await makeSetup()
    const id = crypto.randomUUID()
    let ownershipVisibleInsideTx = false

    await expect(
      runAs(engine, u1, () =>
        db.transaction(async tx => {
          await tx.insert(posts).values({ id, title: 'doomed' })
          // The ownership row must have been written through the SAME tx.
          const inside = await (tx as unknown as typeof pg.db)
            .select()
            .from(pgSchema.rbacResourceOwners)
          ownershipVisibleInsideTx = inside.length === 1
          throw new Error('boom')
        }),
      ),
    ).rejects.toThrow('boom')

    expect(ownershipVisibleInsideTx).toBe(true)
    expect(await pg.db.select().from(posts)).toHaveLength(0)
    expect(await ownershipRows(pg)).toHaveLength(0)
    expect(await adapter.isOwner('u1', { type: 'post', id })).toBe(false)
  })

  // ── (d) ownership write failure rejects — the v0 hang regression ──────────

  test('d: when the ownership insert fails, the awaited insert REJECTS (never hangs, never resolves)', async () => {
    const { pg, engine, db } = await makeSetup()
    await pg.client.exec('DROP TABLE "rbac_resource_owners"')
    const id = crypto.randomUUID()

    const outcome = await Promise.race([
      runAs(engine, u1, async () => {
        await db.insert(posts).values({ id, title: 'orphan' })
      }).then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      // Timeout guard: the v0 regression made this await hang forever.
      new Promise<'hang'>(resolve => setTimeout(() => resolve('hang'), 250)),
    ])

    expect(outcome).toBe('rejected')
  })

  // ── (e) no ALS context ─────────────────────────────────────────────────────

  test('e: with no request context (seeders/CLI/jobs) the insert succeeds with no ownership row and no throw', async () => {
    const { pg, db } = await makeSetup()
    const id = crypto.randomUUID()

    await db.insert(posts).values({ id, title: 'seeded' })

    expect(await pg.db.select().from(posts)).toHaveLength(1)
    expect(await ownershipRows(pg)).toHaveLength(0)
  })

  test('e: a request context with no subject set also skips tracking silently', async () => {
    const { pg, engine, db } = await makeSetup()
    const id = crypto.randomUUID()

    await engine.store.run(async () => {
      await db.insert(posts).values({ id, title: 'anon' })
    })

    expect(await ownershipRows(pg)).toHaveLength(0)
  })

  // ── (f) strictTracking modes (serial ids, no values-ids, no .returning()) ──

  test("f: strictTracking 'error' rejects with MisconfiguredError when ids are unobtainable — and does not insert", async () => {
    const { pg, engine, db } = await makeSetup({ strictTracking: 'error' })

    let caught: unknown
    await runAs(engine, u1, async () => {
      try {
        await db.insert(events).values({ title: 'untrackable' })
      } catch (error) {
        caught = error
      }
    })

    expect(caught).toBeInstanceOf(MisconfiguredError)
    expect(await pg.db.select().from(events)).toHaveLength(0)
  })

  test("f: strictTracking 'error' does not fire when ids ARE obtainable (values ids or .returning())", async () => {
    const { adapter, engine, db } = await makeSetup({ strictTracking: 'error' })
    const id = crypto.randomUUID()

    await runAs(engine, u1, async () => {
      await db.insert(posts).values({ id, title: 'fine' })
      await db.insert(events).values({ title: 'fine too' }).returning()
    })

    expect(await adapter.isOwner('u1', { type: 'post', id })).toBe(true)
  })

  test("f: strictTracking 'warn' (default) warns ONCE per resource and still inserts", async () => {
    const { pg, engine, db } = await makeSetup({ strictTracking: 'warn' })
    const warn = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await runAs(engine, u1, async () => {
        await db.insert(events).values({ title: 'one' })
        await db.insert(events).values({ title: 'two' })
      })

      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('"event"')
      expect(await pg.db.select().from(events)).toHaveLength(2)
      expect(await ownershipRows(pg)).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })

  test("f: strictTracking 'off' is silent — no warn, no throw, no ownership", async () => {
    const { pg, engine, db } = await makeSetup({ strictTracking: 'off' })
    const warn = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await runAs(engine, u1, async () => {
        await db.insert(events).values({ title: 'quiet' })
      })

      expect(warn).not.toHaveBeenCalled()
      expect(await pg.db.select().from(events)).toHaveLength(1)
      expect(await ownershipRows(pg)).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })

  // ── (g) untracked bypass ───────────────────────────────────────────────────

  test('g: db.untracked bypasses ownership tracking even with an active subject', async () => {
    const { pg, engine, db } = await makeSetup()
    const id = crypto.randomUUID()

    await runAs(engine, u1, async () => {
      await db.untracked.insert(posts).values({ id, title: 'raw' })
    })

    expect(await pg.db.select().from(posts)).toHaveLength(1)
    expect(await ownershipRows(pg)).toHaveLength(0)
  })
})

// ── (h) automatic read filtering on select ────────────────────────────────────

const cashier: Subject = { id: 'cashier' }
const manager: Subject = { id: 'manager' }
const outsider: Subject = { id: 'outsider' }

async function makeFilterSetup() {
  const pg = await makePgDb(USER_DDL)
  cleanups.push(pg.close)

  const adapter = drizzleAdapter(pg.db, { schema: pgSchema })

  let rowsSeenDuringCheck = -1
  const auditScope = new Scope('audit-window', 'Audit window', async () => {
    const seen = await db.select().from(sales)
    rowsSeenDuringCheck = seen.length
    return true
  })

  const resources: ResourceDefinition[] = [
    {
      type: 'sale',
      policies: [
        new Policy('sales.view', { scopeOptions: [Scope.owned()] }),
        new Policy('sales.audit', { scopeOptions: [auditScope] }),
      ],
      table: sales,
      list: 'sales.view',
    },
    // Registered for tracking but no `list` — auto mode off.
    { type: 'post', policies: [], table: posts },
  ]
  const rbac = createRbac({ adapter, resources, cache: false })
  cleanups.push(async () => rbac.dispose())

  const db = trackedDb(pg.db, { rbac: { engine: rbac.engine, adapter }, resources })

  await rbac.sync()
  await rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'sales.view', 'owned')
  await rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'sales.audit', 'audit-window')
  await rbac.admin.assignPolicy({ subjectId: 'manager' }, 'sales.view')

  await pg.db.insert(sales).values([
    { id: 's1', status: 'open' },
    { id: 's2', status: 'void' },
    { id: 's3', status: 'open' },
  ])
  await rbac.ownership.record('cashier', { type: 'sale', id: 's1' })
  await rbac.ownership.record('cashier', { type: 'sale', id: 's2' })
  await rbac.ownership.record('u9', { type: 'sale', id: 's3' })

  return { pg, engine: rbac.engine, db, rowsSeenDuringCheck: () => rowsSeenDuringCheck }
}

describe('trackedDb — automatic read filtering on select (pg)', () => {
  test("h: an 'owned'-scoped grant filters plain db.select() to the subject's rows", async () => {
    const { engine, db } = await makeFilterSetup()

    const rows = await runAs(engine, cashier, () => db.select().from(sales))
    expect(rows.map(row => row.id).sort()).toEqual(['s1', 's2'])
  })

  test('h: a user .where() is ANDed with the grant filter', async () => {
    const { engine, db } = await makeFilterSetup()

    const open = await runAs(engine, cashier, () =>
      db.select().from(sales).where(eq(sales.status, 'open')),
    )
    expect(open.map(row => row.id)).toEqual(['s1'])

    // s3 matches the user filter but not the grant — the filter must win.
    const foreign = await runAs(engine, cashier, () =>
      db.select().from(sales).where(eq(sales.id, 's3')),
    )
    expect(foreign).toEqual([])
  })

  test('h: chained builder methods after from() keep the filter', async () => {
    const { engine, db } = await makeFilterSetup()

    const rows = await runAs(engine, cashier, () =>
      db.select().from(sales).orderBy(asc(sales.id)).limit(10),
    )
    expect(rows.map(row => row.id)).toEqual(['s1', 's2'])
  })

  test('h: an unscoped grant sees every row (all — query untouched)', async () => {
    const { engine, db } = await makeFilterSetup()

    const rows = await runAs(engine, manager, () => db.select().from(sales))
    expect(rows).toHaveLength(3)
  })

  test('h: no grant yields an empty list, not an error (none)', async () => {
    const { engine, db } = await makeFilterSetup()

    const rows = await runAs(engine, outsider, () => db.select().from(sales))
    expect(rows).toEqual([])
  })

  test('h: a scope check querying the table during authorize sees it UNFILTERED (inAuthz suppression)', async () => {
    const { engine, db, rowsSeenDuringCheck } = await makeFilterSetup()

    await runAs(engine, cashier, () => engine.authorize(cashier, 'sales.audit'))
    expect(rowsSeenDuringCheck()).toBe(3)

    // The suppression does not leak past authorize.
    const after = await runAs(engine, cashier, () => db.select().from(sales))
    expect(after.map(row => row.id).sort()).toEqual(['s1', 's2'])
  })

  test('h: db.untracked selects are never filtered', async () => {
    const { engine, db } = await makeFilterSetup()

    const rows = await runAs(engine, cashier, () => db.untracked.select().from(sales))
    expect(rows).toHaveLength(3)
  })

  test('h: with no request subject (seeders/CLI/jobs) selects are unfiltered', async () => {
    const { db } = await makeFilterSetup()

    expect(await db.select().from(sales)).toHaveLength(3)
  })

  test('h: a registered resource WITHOUT `list` is never filtered', async () => {
    const { pg, engine, db } = await makeFilterSetup()
    await pg.db.insert(posts).values({ id: 'p1', title: 'P1' })

    const rows = await runAs(engine, cashier, () => db.select().from(posts))
    expect(rows).toHaveLength(1)
  })

  test('h: selects on unregistered tables are never filtered', async () => {
    const { pg, engine, db } = await makeFilterSetup()
    const strangers = pgTable('strangers', { id: text('id').primaryKey() })
    await pg.client.exec('CREATE TABLE "strangers" ("id" text PRIMARY KEY)')
    await pg.db.insert(strangers).values({ id: 'x1' })

    const rows = await runAs(engine, cashier, () => db.select().from(strangers))
    expect(rows).toHaveLength(1)
  })
})

// ── (i) sqlite leg ────────────────────────────────────────────────────────────

const salesLite = sqliteTable('sales', {
  id: sqliteText('id').primaryKey(),
  status: sqliteText('status').notNull(),
})

const SQLITE_USER_DDL = `
CREATE TABLE sales (id text PRIMARY KEY, status text NOT NULL);
`

async function makeSqliteFilterSetup() {
  const { db: raw, sqlite } = makeSqliteDb(SQLITE_USER_DDL)
  cleanups.push(async () => sqlite.close())

  const adapter = drizzleAdapter(raw, { schema: sqliteSchema })
  const resources: ResourceDefinition[] = [
    {
      type: 'sale',
      policies: [new Policy('sales.view', { scopeOptions: [Scope.owned()] })],
      table: salesLite,
      list: 'sales.view',
    },
  ]
  const rbac = createRbac({ adapter, resources, cache: false })
  cleanups.push(async () => rbac.dispose())

  const db = trackedDb(raw, { rbac: { engine: rbac.engine, adapter }, resources })

  await rbac.sync()
  await rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'sales.view', 'owned')
  await rbac.admin.assignPolicy({ subjectId: 'manager' }, 'sales.view')

  await raw.insert(salesLite).values([
    { id: 's1', status: 'open' },
    { id: 's2', status: 'void' },
    { id: 's3', status: 'open' },
  ])
  await rbac.ownership.record('cashier', { type: 'sale', id: 's1' })
  await rbac.ownership.record('cashier', { type: 'sale', id: 's2' })
  await rbac.ownership.record('u9', { type: 'sale', id: 's3' })

  return { engine: rbac.engine, db }
}

describe('trackedDb — automatic read filtering on select (sqlite)', () => {
  test("i: an 'owned'-scoped grant filters plain db.select() to the subject's rows", async () => {
    const { engine, db } = await makeSqliteFilterSetup()

    const rows = await runAs(engine, cashier, () => db.select().from(salesLite))
    expect(rows.map(row => row.id).sort()).toEqual(['s1', 's2'])
  })

  test('i: a user .where() is ANDed with the grant filter, including through .all()', async () => {
    const { engine, db } = await makeSqliteFilterSetup()

    const open = await runAs(engine, cashier, async () =>
      db.select().from(salesLite).where(eq(salesLite.status, 'open')).all(),
    )
    expect(open.map(row => row.id)).toEqual(['s1'])
  })

  test('i: an unscoped grant sees every row', async () => {
    const { engine, db } = await makeSqliteFilterSetup()

    const rows = await runAs(engine, manager, () => db.select().from(salesLite))
    expect(rows).toHaveLength(3)
  })

  test('i: no grant yields an empty list, not an error', async () => {
    const { engine, db } = await makeSqliteFilterSetup()

    const rows = await runAs(engine, outsider, () => db.select().from(salesLite))
    expect(rows).toEqual([])
  })

  test('i: db.untracked selects are never filtered', async () => {
    const { engine, db } = await makeSqliteFilterSetup()

    const rows = await runAs(engine, cashier, () => db.untracked.select().from(salesLite))
    expect(rows).toHaveLength(3)
  })
})
