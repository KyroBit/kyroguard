/// <reference types="bun-types" />
/**
 * Runs the executable storage contract (S1–S20) against the drizzle adapter
 * on SQLite via bun:sqlite. This exercises the synchronous sqlite driver path
 * of the dialect-generic adapter (integer booleans, text-json columns,
 * NOT NULL DEFAULT '' sentinels) — a fresh in-memory database per case.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

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
