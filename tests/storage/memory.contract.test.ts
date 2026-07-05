/// <reference types="bun-types" />
/**
 * Runs the executable storage contract (S1–S20) against the in-memory
 * reference adapter under bun:test. The reference adapter must pass its own
 * specification — this is the anchor every other adapter is measured against.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { memoryAdapter, runStorageAdapterContractSuite } from '../../src/testing/index.js'

runStorageAdapterContractSuite({
  name: 'memory',
  makeAdapter: async () => ({ adapter: memoryAdapter() }),
  test: { describe, it: test, expect, beforeEach, afterAll },
})
