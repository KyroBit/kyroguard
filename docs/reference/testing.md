# Testing

Reference for `@kyrobit/rbac/testing`: an in-memory adapter for fast app tests and two contract suites — one for storage adapters, one for framework integrations. Both suites are runner-injected: pass `{ describe, it, expect }` from `bun:test` or Vitest. For usage guidance, see [Testing your app](/guide/testing-your-app).

## memoryAdapter()

```ts
import { memoryAdapter } from '@kyrobit/rbac/testing'

function memoryAdapter(): StorageAdapter
```

A complete in-memory `StorageAdapter` — the reference implementation of the storage contract (clauses S1–S20) and the fastest way to test guarded routes without a database. Every behavior is normative: other adapters are measured against it via the contract suite.

- `id`: `'memory'`.
- `capabilities`: `{ autoOwnershipTracking: false, queryScoping: false }`.
- `ensureSchema()`: no-op.
- Ids are `mem_1`, `mem_2`, … — opaque and stable within one instance.

```ts
import { createRbac, Policy } from '@kyrobit/rbac'
import { memoryAdapter } from '@kyrobit/rbac/testing'

const rbac = createRbac({
  adapter: memoryAdapter(),
  resources: [{ type: 'post', policies: [new Policy('posts.read')] }],
})
await rbac.sync(rbac.resources, 'admin')
```

## SuiteTestApi

The runner injection shape both suites take as `test`:

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
import { runStorageAdapterContractSuite } from '@kyrobit/rbac/testing'

function runStorageAdapterContractSuite(options: StorageAdapterSuiteOptions): void

interface StorageAdapterSuiteOptions {
  name: string
  makeAdapter: () => Promise<{ adapter: StorageAdapter; cleanup?: () => Promise<void> }>
  test: SuiteTestApi
}
```

The executable specification of the storage contract. Every clause S1–S20 has at least one case named with its clause id; an adapter is conforming exactly when the suite passes. Covered: `''`-sentinel storage (S1), strict tuple matching — the tenant-isolation invariant (S2), group plus direct grants (S3), no deduplication and stable ordering (S4), metadata updates on re-sync (S5/S15), delete cascades (S6), group upsert semantics including omitted-field preservation (S7), exact entry replacement (S8), additive idempotent entry adds (S9), idempotent assignment upserts (S10), exact-tuple removals (S11), `UnknownPolicyError` on unsynced policies (S12), ownership upsert/match/removal (S13), stable policy ids (S14), qualified names from `getGroupPolicies` (S16), `ensureSchema` idempotency (S17), rejected invalid mutations (S18), portal-column orphan filtering (S19), and the inactive-group kill-switch (S20).

| Option | Description |
| --- | --- |
| `name` | Appears in the `describe` title: `storage adapter contract: <name>`. |
| `makeAdapter` | Called once **per test case** — cases never share state. Return a fresh adapter backed by a clean database (or a fresh schema/collection namespace). |
| `cleanup` | Optional per-case teardown returned by `makeAdapter`. When omitted, the suite calls `adapter.close?.()` instead. |
| `test` | Runner injection — see [SuiteTestApi](#suitetestapi). |

```ts
// my-adapter.contract.test.ts
import { describe, it, expect } from 'bun:test'
import { runStorageAdapterContractSuite } from '@kyrobit/rbac/testing'
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

::: warning
`makeAdapter` runs for every case — around fifty times. Returning an adapter that reuses a dirty database makes unrelated clauses fail with confusing diffs — isolate state per call (transaction rollback, schema-per-case, or a truncate in `cleanup`).
:::

## runFrameworkContractSuite()

```ts
import { runFrameworkContractSuite } from '@kyrobit/rbac/testing'

function runFrameworkContractSuite(options: FrameworkSuiteOptions): void

interface FrameworkSuiteOptions {
  name: string
  makeApp: (rbac: Rbac, routes: RouteSpec[]) => Promise<TestApp>
  test: SuiteTestApi
}
```

Black-box HTTP contract for framework integrations. The suite builds its own `Rbac` instances on `memoryAdapter()` and seeds grants per case; your `makeApp` only translates `RouteSpec[]` into a running app. The 13 cases verify: 401 `RBAC_UNAUTHENTICATED` without a subject, 403 `RBAC_POLICY_DENIED` without a grant, 200 with one, portal isolation, context isolation, `is_super` bypass, scoped grants (200 / 403 `RBAC_SCOPE_DENIED` / 404 `RBAC_RESOURCE_NOT_FOUND`), independent subjects for two portals on one app, exactly-once `getSubject` across stacked guards, errors traveling the framework's own pipeline, and mid-process cache invalidation on `assignGroup`/`removeGroup`.

### RouteSpec

```ts
interface RouteSpec {
  method: 'GET' | 'POST'
  path: string
  portal: string
  policy?: string        // '+'-separated UNQUALIFIED policy names
  resource?: (req: any) => { type: string; id: string } | null
  getSubjectFrom?: 'header'
}
```

### TestApp

```ts
interface TestApp {
  request(opts: {
    method: 'GET' | 'POST'
    path: string
    headers?: Record<string, string>
  }): Promise<TestAppResponse>
  close(): Promise<void>
}

interface TestAppResponse {
  status: number
  body: any                        // parsed JSON
  headers: Record<string, string>  // lowercase names
}
```

### Harness protocol

Every `makeApp` implementation MUST satisfy all four requirements — the suite asserts each one:

1. **Portals and subject resolution.** Create one portal per distinct `route.portal` via the integration's portal factory. When `getSubjectFrom === 'header'`, `getSubject` reads:

   | Header | Meaning |
   | --- | --- |
   | `x-subject-id` | Subject id. Absent or empty → return `null` (→ 401). |
   | `x-context-id` | `context_id`, when present. |
   | `x-super: '1'` | `is_super: true`. |

   `getSubject` must count its own invocations per request, and **every** response must carry the header `x-getsubject-calls` with that request's total. This proves guard-time memoization: case 11 stacks two guards from one portal and expects `x-getsubject-calls: '1'`.

2. **Routes and guards.** Mount each route at `(method, path)`. When `policy` is set, attach one `requirePolicy` guard per `'+'`-separated unqualified policy name (the portal qualifies them), forwarding `resource` when provided. The success handler responds 200 with JSON `{ ok: true }`.

3. **Framework pipeline proof.** Register a framework-level hook/middleware that adds the header `x-app-hook: ran` to **every** response, **including error responses**. RbacErrors must travel the framework's own error pipeline — a hijacked reply that writes directly to the socket skips the hook and fails case 12.

4. **Response normalization.** `TestApp.request` results use lowercase header names and a parsed JSON body.

```ts
// my-framework.contract.test.ts
import { describe, it, expect } from 'bun:test'
import { runFrameworkContractSuite } from '@kyrobit/rbac/testing'
import { makeTestApp } from './harness.js' // your RouteSpec[] → TestApp translation

runFrameworkContractSuite({
  name: 'my-framework',
  makeApp: makeTestApp,
  test: { describe, it, expect },
})
```

::: warning
Forgetting `x-app-hook` on error responses is the most common harness mistake — it usually means your integration formats denials by writing to the raw response instead of throwing through the framework's error pipeline. That is the exact regression the case exists to catch, not a defect in the harness.
:::
