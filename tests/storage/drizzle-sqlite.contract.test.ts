/// <reference types="bun-types" />
/**
 * Runs the executable storage contract against the drizzle adapter on SQLite
 * via bun:sqlite. This exercises the synchronous sqlite driver path of the
 * dialect-generic adapter (integer booleans, text-json columns, NOT NULL
 * DEFAULT '' sentinels) — a fresh in-memory database per case.
 *
 * The listFilters block below the suite runs the fragment composition the engine
 * relies on — or() and none() — as real selects against real rows.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { drizzleAdapter } from '../../src/storage/drizzle/index.js'
import * as schema from '../../src/storage/drizzle/schema/sqlite.js'
import { runStorageAdapterContractSuite } from '../../src/testing/index.js'
import { makeSqliteDb } from './helpers/sqlite.js'

runStorageAdapterContractSuite({
  name: 'drizzle-sqlite (bun:sqlite)',
  makeAdapter: async () => {
    const { db, sqlite } = makeSqliteDb()
    return {
      adapter: drizzleAdapter(db, { schema }),
      cleanup: async () => {
        sqlite.close()
      },
    }
  },
  test: { describe, it: test, expect, beforeEach, afterAll },
})

// ── listFilters: the engine's fragment composition, run as real selects ──────

const lfDocs = sqliteTable('lf_docs', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})

const LF_DDL = `CREATE TABLE lf_docs (id text PRIMARY KEY NOT NULL, title text NOT NULL);`

describe('drizzle-sqlite listFilters', () => {
  async function makeFixture() {
    const { db, sqlite } = makeSqliteDb(LF_DDL)
    const adapter = drizzleAdapter(db, { schema })

    await db.insert(lfDocs).values([
      { id: 'd1', title: 'D1' },
      { id: 'd2', title: 'D2' },
      { id: 'd3', title: 'D3' },
    ])

    return { db, adapter, cleanup: async () => sqlite.close() }
  }

  const listIds = async (db: ReturnType<typeof makeSqliteDb>['db'], where: SQL) => {
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
