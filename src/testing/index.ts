/**
 * @kyrobit/rbac/testing — the public testing kit.
 *
 * - memoryAdapter(): a complete in-memory StorageAdapter — the reference
 *   implementation of the storage contract (S1–S20) and the fastest way to
 *   test guarded routes without a database.
 * - runStorageAdapterContractSuite(): the executable specification of
 *   src/storage/contract.ts. Run it against any adapter (including your own)
 *   to prove conformance; an adapter is conforming exactly when it passes.
 * - runFrameworkContractSuite(): black-box HTTP contract for framework
 *   integrations — portals, guards, error strategy, subject memoization and
 *   cache invalidation.
 *
 * Both suites are runner-injected: pass { describe, it, expect } from
 * bun:test or vitest.
 */

export { memoryAdapter } from './memory-adapter.js'
export { runStorageAdapterContractSuite } from './adapter-suite.js'
export type { StorageAdapterSuiteOptions, SuiteTestApi } from './adapter-suite.js'
export { runFrameworkContractSuite } from './framework-suite.js'
export type {
  FrameworkSuiteOptions,
  RouteSpec,
  TestApp,
  TestAppResponse,
} from './framework-suite.js'
