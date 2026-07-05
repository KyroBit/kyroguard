/// <reference types="bun-types" />
/**
 * Runs the executable storage contract (S1–S23) against the Mongoose adapter
 * on a real mongod (mongodb-memory-server). Every case gets a fresh
 * connection + unique database via the shared helper, with ensureSchema()
 * (syncIndexes) completed before the adapter is used — the S10/S13 idempotent
 * upserts depend on those unique indexes existing.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { runStorageAdapterContractSuite } from '../../src/testing/index.js'
import { makeAdapter, mongoAvailable, stopMongo } from './helpers/mongo.js'

const available = await mongoAvailable()

afterAll(stopMongo)

if (!available) {
  // mongod binary could not be downloaded/booted in this environment.
  test.skip('mongoose storage contract suite (mongod unavailable)', () => {})
} else {
  runStorageAdapterContractSuite({
    name: 'mongoose',
    makeAdapter,
    test: {
      describe,
      // Generous per-case timeout: each case opens a fresh connection and
      // syncs indexes on a real mongod.
      it: (name, fn) => test(name, fn, 15_000),
      expect,
      beforeEach,
      afterAll,
    },
  })
}
