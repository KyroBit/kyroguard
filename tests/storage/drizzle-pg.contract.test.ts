/// <reference types="bun-types" />
/**
 * Runs the executable storage contract against the Drizzle adapter on real
 * PostgreSQL semantics via @electric-sql/pglite. Every case gets a fresh
 * in-memory database, so cases never share state; instances are closed after
 * each case and any strays are swept in afterAll.
 *
 * The listFilters block below the suite runs the fragment composition the engine
 * relies on — or() and none() — as real selects against real rows.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { pgTable, text } from 'drizzle-orm/pg-core'

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

// ── listFilters: the engine's fragment composition, run as real selects ──────

const lfDocs = pgTable('lf_docs', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

const LF_DDL = `CREATE TABLE "lf_docs" ("id" text PRIMARY KEY, "title" text NOT NULL);`

describe('drizzle-pg listFilters', () => {
  async function makeFixture() {
    const { db, close } = await makePgDb(LF_DDL)
    open.add(close)
    const adapter = drizzleAdapter(db, { schema: pgSchema })

    await db.insert(lfDocs).values([
      { id: 'd1', title: 'D1' },
      { id: 'd2', title: 'D2' },
      { id: 'd3', title: 'D3' },
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

  test('or() unions two scopes\' fragments into the rows either one allows', async () => {
    const { db, adapter, cleanup } = await makeFixture()
    try {
      const combined = adapter.listFilters!.or([eq(lfDocs.id, 'd1'), eq(lfDocs.id, 'd2')]) as SQL
      expect(await listIds(db, combined)).toEqual(['d1', 'd2'])
    } finally {
      await cleanup()
    }
  })

  test('or() with no fragments yields zero rows rather than every row', async () => {
    const { db, adapter, cleanup } = await makeFixture()
    try {
      expect(await listIds(db, adapter.listFilters!.or([]) as SQL)).toEqual([])
    } finally {
      await cleanup()
    }
  })

  test('none() yields zero rows', async () => {
    const { db, adapter, cleanup } = await makeFixture()
    try {
      expect(await listIds(db, adapter.listFilters!.none() as SQL)).toEqual([])
    } finally {
      await cleanup()
    }
  })

  test("a combined fragment composes with the caller's own where", async () => {
    const { db, adapter, cleanup } = await makeFixture()
    try {
      const combined = adapter.listFilters!.or([eq(lfDocs.id, 'd1'), eq(lfDocs.id, 'd2')]) as SQL
      expect(await listIds(db, and(eq(lfDocs.title, 'D2'), combined)!)).toEqual(['d2'])
      // Matches the caller's filter but not the scopes — the scopes must win.
      expect(await listIds(db, and(eq(lfDocs.title, 'D3'), combined)!)).toEqual([])
    } finally {
      await cleanup()
    }
  })
})
