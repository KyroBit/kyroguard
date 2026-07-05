/// <reference types="bun-types" />
/**
 * Runs the executable storage contract against the Drizzle adapter on real
 * PostgreSQL semantics via @electric-sql/pglite. Every case gets a fresh
 * in-memory database, so cases never share state; instances are closed after
 * each case and any strays are swept in afterAll.
 *
 * The listFilters block below the suite exercises the pg EXISTS fragments
 * end-to-end: seeded access entries, real selects with the fragment ANDed in.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { pgTable, serial, text } from 'drizzle-orm/pg-core'

import type { ResourceDefinition } from '../../src/index.js'
import { drizzleAdapter } from '../../src/storage/drizzle/index.js'
import * as pgSchema from '../../src/storage/drizzle/schema/pg.js'
import { runStorageAdapterContractSuite } from '../../src/testing/index.js'
import { makePgDb } from './helpers/pg.js'

const open = new Set<() => Promise<void>>()

runStorageAdapterContractSuite({
  name: 'drizzle-pg (pglite)',
  makeAdapter: async () => {
    const { db, close } = await makePgDb()
    open.add(close)
    const adapter = drizzleAdapter(db, { schema: pgSchema })
    return {
      adapter,
      cleanup: async () => {
        open.delete(close)
        await close()
      },
    }
  },
  test: { describe, it: test, expect, beforeEach, afterAll },
})

afterAll(async () => {
  await Promise.all([...open].map(close => close().catch(() => {})))
  open.clear()
})

// ── listFilters: real selects with the EXISTS fragments ANDed in ─────────────

const lfDocs = pgTable('lf_docs', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

const lfEvents = pgTable('lf_events', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
})

const lfNotes = pgTable('lf_notes', {
  code: text('code').primaryKey(),
  title: text('title').notNull(),
})

const LF_DDL = `
CREATE TABLE "lf_docs" ("id" text PRIMARY KEY, "title" text NOT NULL);
CREATE TABLE "lf_events" ("id" serial PRIMARY KEY, "title" text NOT NULL);
CREATE TABLE "lf_notes" ("code" text PRIMARY KEY, "title" text NOT NULL);
`

const docResource: ResourceDefinition = { type: 'doc', policies: [], table: lfDocs }
const eventResource: ResourceDefinition = { type: 'event', policies: [], table: lfEvents }
const noteResource: ResourceDefinition = {
  type: 'note',
  policies: [],
  table: lfNotes,
  fields: { id: lfNotes.code },
}

function fragmentOf(result: { where: unknown } | false): SQL {
  if (result === false) throw new Error('expected a fragment, got false')
  return result.where as SQL
}

describe('drizzle-pg listFilters', () => {
  async function makeFixture() {
    const { db, close } = await makePgDb(LF_DDL)
    open.add(close)
    const adapter = drizzleAdapter(db, { schema: pgSchema })

    await db.insert(lfDocs).values([
      { id: 'd1', title: 'D1' },
      { id: 'd2', title: 'D2' },
      { id: 'd3', title: 'D3' },
      { id: 'd4', title: 'D4' },
    ])
    await adapter.recordOwnership([
      { resourceType: 'doc', resourceId: 'd1', ownerId: 'u1', domain: '', tenantId: '' },
      { resourceType: 'doc', resourceId: 'd2', ownerId: 'u1', relation: 'granted', domain: '', tenantId: 't1' },
      { resourceType: 'doc', resourceId: 'd3', ownerId: 'u2', domain: '', tenantId: 't1' },
      // Same id under ANOTHER resource type — must never leak into 'doc' filters.
      { resourceType: 'other', resourceId: 'd4', ownerId: 'u1', domain: '', tenantId: 't1' },
    ])

    const cleanup = async () => {
      open.delete(close)
      await close()
    }
    return { db, adapter, cleanup }
  }

  const listIds = async (db: Awaited<ReturnType<typeof makePgDb>>['db'], where: SQL) => {
    const rows = await db.select().from(lfDocs).where(where).orderBy(lfDocs.id)
    return rows.map(row => row.id)
  }

  test("owned(): matches only the subject's relation-'owner' entries of that resource type", async () => {
    const { db, adapter, cleanup } = await makeFixture()
    try {
      const f = fragmentOf(await adapter.listFilters!.owned('u1', docResource, db))
      expect(await listIds(db, f)).toEqual(['d1'])
    } finally {
      await cleanup()
    }
  })

  test("granted(): matches only the subject's relation-'granted' entries", async () => {
    const { db, adapter, cleanup } = await makeFixture()
    try {
      const f = fragmentOf(await adapter.listFilters!.granted('u1', docResource, db))
      expect(await listIds(db, f)).toEqual(['d2'])
    } finally {
      await cleanup()
    }
  })

  test("inTenant(): matches rows with any access entry in the tenant; '' fails closed", async () => {
    const { db, adapter, cleanup } = await makeFixture()
    try {
      const f = fragmentOf(await adapter.listFilters!.inTenant('t1', docResource, db))
      expect(await listIds(db, f)).toEqual(['d2', 'd3'])
      expect(await adapter.listFilters!.inTenant('', docResource, db)).toBe(false)
    } finally {
      await cleanup()
    }
  })

  test('or() unions fragments, an empty or() and none() both yield zero rows', async () => {
    const { db, adapter, cleanup } = await makeFixture()
    try {
      const owned = fragmentOf(await adapter.listFilters!.owned('u1', docResource, db))
      const granted = fragmentOf(await adapter.listFilters!.granted('u1', docResource, db))
      expect(await listIds(db, adapter.listFilters!.or([owned, granted]) as SQL)).toEqual(['d1', 'd2'])
      expect(await listIds(db, adapter.listFilters!.or([]) as SQL)).toEqual([])
      expect(await listIds(db, adapter.listFilters!.none() as SQL)).toEqual([])
    } finally {
      await cleanup()
    }
  })

  test("fragments compose with the caller's where/orderBy/limit", async () => {
    const { db, adapter, cleanup } = await makeFixture()
    try {
      const granted = fragmentOf(await adapter.listFilters!.granted('u1', docResource, db))
      expect(await listIds(db, and(eq(lfDocs.title, 'D2'), granted)!)).toEqual(['d2'])
      // Matches the caller's filter but not the scope — the scope must win.
      expect(await listIds(db, and(eq(lfDocs.title, 'D3'), granted)!)).toEqual([])
    } finally {
      await cleanup()
    }
  })

  test("fields.id maps the correlation when the pk is not named 'id'", async () => {
    const { db, adapter, cleanup } = await makeFixture()
    try {
      await db.insert(lfNotes).values([
        { code: 'n1', title: 'N1' },
        { code: 'n2', title: 'N2' },
      ])
      await adapter.recordOwnership([
        { resourceType: 'note', resourceId: 'n1', ownerId: 'u1', domain: '', tenantId: '' },
      ])
      const f = fragmentOf(await adapter.listFilters!.owned('u1', noteResource, db))
      const rows = await db.select().from(lfNotes).where(f)
      expect(rows.map(row => row.code)).toEqual(['n1'])
    } finally {
      await cleanup()
    }
  })

  test('integer primary keys correlate through the text cast', async () => {
    const { db, adapter, cleanup } = await makeFixture()
    try {
      await db.insert(lfEvents).values([
        { id: 1, title: 'E1' },
        { id: 2, title: 'E2' },
      ])
      await adapter.recordOwnership([
        { resourceType: 'event', resourceId: '1', ownerId: 'u1', domain: '', tenantId: '' },
      ])
      const f = fragmentOf(await adapter.listFilters!.owned('u1', eventResource, db))
      const rows = await db.select().from(lfEvents).where(f)
      expect(rows.map(row => row.id)).toEqual([1])
    } finally {
      await cleanup()
    }
  })

  test('fails closed (false) when the resource has no table or no id column', async () => {
    const { db, adapter, cleanup } = await makeFixture()
    try {
      expect(await adapter.listFilters!.owned('u1', { type: 'x', policies: [] }, db)).toBe(false)
      // A table whose pk is not named 'id' and no fields.id mapping.
      expect(
        await adapter.listFilters!.owned('u1', { type: 'note', policies: [], table: lfNotes }, db),
      ).toBe(false)
    } finally {
      await cleanup()
    }
  })
})
