/** @kyrobit/kyroguard/testing — memoryAdapter, scope-parity helper and the runner-injected contract suites. */

export { memoryAdapter } from './memory-adapter.js'
export type { MemoryWhere } from './memory-adapter.js'
export { runStorageAdapterContractSuite } from './adapter-suite.js'
export type { StorageAdapterSuiteOptions, SuiteTestApi } from './adapter-suite.js'
export { runFrameworkContractSuite } from './framework-suite.js'
export type {
  FrameworkSuiteOptions,
  RouteSpec,
  TestApp,
  TestAppResponse,
} from './framework-suite.js'
export { assertScopeParity } from './assert-scope-parity.js'
export type { AssertScopeParityOptions } from './assert-scope-parity.js'
