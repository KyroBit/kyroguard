/// <reference types="bun-types" />
/**
 * trackedDb (Drizzle) behavior against real PostgreSQL semantics (pglite):
 * ownership auto-tracking on insert (values-ids and .returning() paths),
 * transactional atomicity, the v0 "ownership failure hangs the caller"
 * regression, strictTracking modes, db.untracked bypass, and portal-keyed
 * query scoping with OR-combined scope conditions (the v0 conditions[0]
 * regression).
 */

import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { pgTable, serial, text } from 'drizzle-orm/pg-core'

import { createRbac, MisconfiguredError } from '../../src/index.js'
import type { RbacEngine, ResourceDefinition, Subject } from '../../src/index.js'
import { drizzleAdapter, trackedDb } from '../../src/storage/drizzle/index.js'
import * as pgSchema from '../../src/storage/drizzle/schema/pg.js'
import { makePgDb } from './helpers/pg.js'

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

/** Scoping target: two independent scope dimensions (owner, branch). */
const docs = pgTable('docs', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  ownerId: text('owner_id').notNull(),
  branch: text('branch').notNull(),
})

const USER_DDL = `
CREATE TABLE "posts" ("id" text PRIMARY KEY, "title" text NOT NULL);
CREATE TABLE "events" ("id" serial PRIMARY KEY, "title" text NOT NULL);
CREATE TABLE "docs" (
  "id" text PRIMARY KEY,
  "title" text NOT NULL,
  "owner_id" text NOT NULL,
  "branch" text NOT NULL
);
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
    {
      type: 'doc',
      policies: [],
      table: docs,
      // Keyed by the SUBJECT'S PORTAL; both policies' scope name lists are
      // flattened, deduped, and OR-combined.
      context: { admin: { 'docs.read': ['own', 'branch'] } },
    },
  ]
  const rbac = createRbac({ adapter, resources, cache: false })
  cleanups.push(async () => rbac.dispose())

  const db = trackedDb(pg.db, {
    rbac: { engine: rbac.engine, adapter },
    resources,
    queryScopes: {
      own: subject => eq(docs.ownerId, subject.id),
      branch: subject => eq(docs.branch, (subject['context_id'] as string | undefined) ?? ''),
    },
    ...(options?.strictTracking ? { strictTracking: options.strictTracking } : {}),
  })

  return { pg, adapter, engine: rbac.engine, rbac, db }
}

const runAs = <T>(engine: RbacEngine, subject: Subject, fn: () => Promise<T>): Promise<T> =>
  engine.store.run(async () => {
    engine.store.setSubject(subject)
    return fn()
  })

const u1: Subject = { id: 'u1', portal: 'admin', context_id: 'c1' }

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
      contextType: 'admin',
      contextId: 'c1',
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
    // docs is registered; use raw SQL through an unregistered path instead:
    // a table object NOT in resources — reuse posts' shape via untracked-free
    // proxy by inserting into a table the map does not know.
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

// ── (h) select scoping ────────────────────────────────────────────────────────

describe('trackedDb — portal-keyed query scoping on select', () => {
  /** d1 matches only the 'own' scope, d2 only 'branch', d3 neither. */
  const seedDocs = (pg: Awaited<ReturnType<typeof makePgDb>>) =>
    pg.db.insert(docs).values([
      { id: 'd1', title: 'D1', ownerId: 'u1', branch: 'b2' },
      { id: 'd2', title: 'D2', ownerId: 'u2', branch: 'b1' },
      { id: 'd3', title: 'D3', ownerId: 'u2', branch: 'b2' },
    ])

  const scopedSubject: Subject = { id: 'u1', portal: 'admin', context_id: 'b1' }

  test('h: TWO scope names are OR-combined — rows matching EITHER condition return, others are excluded (v0 conditions[0] regression)', async () => {
    const { pg, engine, db } = await makeSetup()
    await seedDocs(pg)

    const rows = await runAs(engine, scopedSubject, () => db.select().from(docs))

    // d1 only via 'own', d2 only via 'branch' — conditions[0]-only would drop one.
    expect(rows.map(row => row.id).sort()).toEqual(['d1', 'd2'])
  })

  test('h: a user .where() is ANDed with the OR-combined scope', async () => {
    const { pg, engine, db } = await makeSetup()
    await seedDocs(pg)

    const onlyD2 = await runAs(engine, scopedSubject, () =>
      db.select().from(docs).where(eq(docs.title, 'D2')),
    )
    expect(onlyD2.map(row => row.id)).toEqual(['d2'])

    // d3 matches the user filter but neither scope — the scope must win.
    const none = await runAs(engine, scopedSubject, () =>
      db.select().from(docs).where(eq(docs.title, 'D3')),
    )
    expect(none).toEqual([])
  })

  test('h: chained builder methods after from() keep the scope', async () => {
    const { pg, engine, db } = await makeSetup()
    await seedDocs(pg)

    const rows = await runAs(engine, scopedSubject, () =>
      db.select().from(docs).orderBy(docs.id).limit(10),
    )
    expect(rows.map(row => row.id)).toEqual(['d1', 'd2'])
  })

  test("h: a subject on a portal WITHOUT context config for the resource is not scoped", async () => {
    const { pg, engine, db } = await makeSetup()
    await seedDocs(pg)

    const rows = await runAs(engine, { id: 'u1', portal: 'branch', context_id: 'b1' }, () =>
      db.select().from(docs),
    )
    expect(rows).toHaveLength(3)
  })

  test('h: selects on unregistered tables are never scoped', async () => {
    const { pg, engine, db } = await makeSetup()
    const id = crypto.randomUUID()
    await pg.db.insert(posts).values({ id, title: 'p' })

    const rows = await runAs(engine, scopedSubject, () => db.select().from(posts))
    expect(rows).toHaveLength(1)
  })
})
