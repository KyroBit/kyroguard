/// <reference types="bun-types" />
/**
 * Runs the executable storage contract (S1–S20) against the Drizzle adapter
 * on real PostgreSQL semantics via @electric-sql/pglite. Every case gets a
 * fresh in-memory database, so cases never share state; instances are closed
 * after each case and any strays are swept in afterAll.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

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
