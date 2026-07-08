# Testing

Reference for `@kyrobit/kyroguard/testing`: an in-memory adapter for fast app tests, plus two contract suites — one for storage adapters, one for framework integrations. For usage guidance, see [Testing](/guide/testing).

## memoryAdapter()

```ts
import { memoryAdapter } from '@kyrobit/kyroguard/testing'

function memoryAdapter(): StorageAdapter
```

A complete in-memory storage adapter. No database needed. It is also the reference implementation the contract suite measures other adapters against.

```ts
import { createGuard, Policy } from '@kyrobit/kyroguard'
import { memoryAdapter } from '@kyrobit/kyroguard/testing'

const guard = createGuard({
  adapter: memoryAdapter(),
  policies: [new Policy('grades.view')],
})
await guard.sync()
```

- `id` is `'memory'`.
- `capabilities` are `{ autoOwnershipTracking: false, listFiltering: true }`.
- `ensureSchema()` is a no-op.

## SuiteTestApi

Both suites run on your own test runner. Pass `{ describe, it, expect }` from `bun:test` or Vitest:

```ts
interface SuiteTestApi {
  describe: (name: string, fn: () => void) => void
  it: (name: string, fn: () => void | Promise<void>) => void
  expect: any
  beforeEach?: (fn: () => void | Promise<void>) => void
  afterAll?: (fn: () => void | Promise<void>) => void
}
```

## runStorageAdapterContractSuite()

```ts
import { runStorageAdapterContractSuite } from '@kyrobit/kyroguard/testing'

function runStorageAdapterContractSuite(options: StorageAdapterSuiteOptions): void
```

| Option | Description |
| --- | --- |
| `name` | Appears in the `describe` title: `storage adapter contract: <name>`. |
| `makeAdapter` | `() => Promise<{ adapter, cleanup? }>`. Called once per test case. Return a fresh adapter on a clean database. |
| `test` | Your test runner's functions. See [SuiteTestApi](#suitetestapi). |

This suite defines the storage contract. An adapter conforms exactly when the suite passes. It covers policy sync, groups, grants, tenant matching, ownership and cascade deletes. See [Custom adapters](/guide/custom-adapters).

```ts
// my-adapter.contract.test.ts
import { describe, it, expect } from 'bun:test'
import { runStorageAdapterContractSuite } from '@kyrobit/kyroguard/testing'
import { makeMyAdapter } from './my-adapter.js'

runStorageAdapterContractSuite({
  name: 'my-adapter',
  makeAdapter: async () => {
    const { adapter, dropDatabase } = await makeMyAdapter()
    return { adapter, cleanup: dropDatabase }
  },
  test: { describe, it, expect },
})
```

When `cleanup` is omitted, the suite calls `adapter.close?.()` after each case.

::: warning
`makeAdapter` runs for every case — around fifty times. Each call must return a clean database. A dirty database makes unrelated cases fail with confusing diffs.
:::

## runFrameworkContractSuite()

```ts
import { runFrameworkContractSuite } from '@kyrobit/kyroguard/testing'

function runFrameworkContractSuite(options: FrameworkSuiteOptions): void
```

| Option | Description |
| --- | --- |
| `name` | Appears in the `describe` title: `framework integration contract: <name>`. |
| `makeApp` | `(guard: Guard, routes: RouteSpec[]) => Promise<TestApp>`. Builds a running app from route specs. |
| `test` | Your test runner's functions. See [SuiteTestApi](#suitetestapi). |

Black-box HTTP contract for framework integrations. The suite builds its own `Guard` on `memoryAdapter()` and seeds grants per case. Your `makeApp` only translates `RouteSpec[]` into a running app. The 13 cases cover 401/403/404 responses, domain and tenant isolation, `is_super`, scoped grants, per-request memoization and cache invalidation.

```ts
// my-framework.contract.test.ts
import { describe, it, expect } from 'bun:test'
import { runFrameworkContractSuite } from '@kyrobit/kyroguard/testing'
import { makeTestApp } from './harness.js'

runFrameworkContractSuite({
  name: 'my-framework',
  makeApp: makeTestApp,
  test: { describe, it, expect },
})
```

### RouteSpec and TestApp

```ts
interface RouteSpec {
  method: 'GET' | 'POST'
  path: string
  domain: string
  policy?: string        // '+'-separated unqualified policy names
  resource?: (req: any) => { type: string; id: string } | null
  getSubjectFrom?: 'header'
}

interface TestApp {
  request(opts: {
    method: 'GET' | 'POST'
    path: string
    headers?: Record<string, string>
  }): Promise<{ status: number; body: any; headers: Record<string, string> }>
  close(): Promise<void>
}
```

### The makeApp contract

The suite asserts each of these. Your `makeApp` must:

- Create one domain per distinct `route.domain` via your integration's domain factory.
- When `getSubjectFrom` is `'header'`, read the user from request headers: `x-subject-id` is the user id (absent or empty means `null`, so 401), `x-tenant-id` sets `tenant_id`, and `x-super: '1'` sets `is_super: true`.
- Count `getSubject` calls per request. Send the total on every response as the `x-getsubject-calls` header. This proves `getSubject` runs once even with stacked guards.
- Mount each route at `(method, path)`. When `policy` is set, attach one `requirePolicy` guard per `'+'`-separated name, forwarding `resource` when given. On success respond 200 with `{ ok: true }`.
- Add the header `x-app-hook: ran` to every response via a framework-level hook — including error responses. This proves denials travel the framework's own error pipeline.
- Return responses with lowercase header names and a parsed JSON body.

Missing `x-app-hook` on error responses is the most common harness mistake. It usually means your integration writes denials to the raw response instead of throwing through the framework's error pipeline.
