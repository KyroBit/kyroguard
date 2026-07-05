# Writing a storage adapter

You implement the `StorageAdapter` interface for a backend the package does not ship, then prove conformance by running the contract test suite against it. An adapter that passes the suite behaves identically to the built-in Drizzle, Prisma and Mongoose adapters from the engine's point of view.

::: tip Prerequisites
You know the storage model — six tables/collections, the `''` sentinel, strict `(portal, contextId)` matching — from [Database schema](/reference/database-schema), and the full interface from the [Core API reference](/reference/core-api#storageadapter).
:::

## The contract in one paragraph

`StorageAdapter` (exported as a type from `@kyrobit/rbac`) is the only boundary between the engine and your storage. It covers five areas: policy sync (`upsertPolicies`, `listPolicies`, `deletePolicies`), groups (`upsertGroup`, `listGroups`, `getGroupPolicies`, `setGroupPolicies`, `addGroupPolicies`), assignments (`assignGroup`, `removeGroup`, `assignPolicy`, `removePolicy`), the enforcement hot path (`getSubjectPolicies`), and ownership (`recordOwnership`, `isOwner`, `removeOwnership`). Two optional hooks — `ensureSchema()` and `close()` — cover DDL and connection lifecycle. The normative semantics are twenty numbered clauses (S1–S20) documented in `src/storage/contract.ts`; each clause maps to at least one case in the contract suite, so "conforming" is not a judgment call — an adapter conforms exactly when the suite passes.

## Skeleton

```ts
// src/my-adapter.ts
import { UnknownPolicyError } from '@kyrobit/rbac'
import type {
  GroupPolicyEntry,
  GroupRecord,
  OwnershipEntry,
  PolicyDefinitionRow,
  PolicyGrant,
  PolicyRecord,
  ResourceRef,
  StorageAdapter,
  SubjectRef,
} from '@kyrobit/rbac'

export function myAdapter(client: MyDbClient): StorageAdapter {
  return {
    id: 'my-adapter',
    capabilities: { autoOwnershipTracking: false, queryScoping: false },

    async upsertPolicies(rows: PolicyDefinitionRow[]) { /* ... */ },
    async listPolicies(): Promise<PolicyRecord[]> { /* ... */ },
    async deletePolicies(ids: string[]) { /* ... */ },

    async upsertGroup(group) { /* ... */ },
    async listGroups(): Promise<GroupRecord[]> { /* ... */ },
    async getGroupPolicies(groupName): Promise<GroupPolicyEntry[]> { /* ... */ },
    async setGroupPolicies(groupName, entries) { /* ... */ },
    async addGroupPolicies(groupName, entries) { /* ... */ },

    async assignGroup(ref: SubjectRef, groupName) { /* ... */ },
    async removeGroup(ref, groupName) { /* ... */ },
    async assignPolicy(ref, policyName, scope) {
      // S12: reject names that were never synced.
      // throw new UnknownPolicyError(policyName)
    },
    async removePolicy(ref, policyName) { /* ... */ },

    async getSubjectPolicies(ref): Promise<PolicyGrant[]> { /* ... */ },

    async recordOwnership(entries: OwnershipEntry[]) { /* ... */ },
    async isOwner(ownerId, resource: ResourceRef) { /* ... */ },
    async removeOwnership(resource) { /* ... */ },
  }
}
```

`capabilities` is metadata for diagnostics (`rbac status`) and documentation, not a behavior switch: set `autoOwnershipTracking` and `queryScoping` to `true` only if you also ship an equivalent of `trackedDb`, the Prisma extension or the Mongoose plugin for your backend.

## The clauses that catch real bugs

All twenty clauses are in `src/storage/contract.ts`; these are the ones adapters most often get wrong:

- **S1 — sentinels.** Store `portal`, `contextId` and `contextType` as non-null strings, `''` meaning "none". Never `NULL`: unique constraints must see one value for "none" and matching must be plain equality.
- **S2 — strict matching.** `getSubjectPolicies` matches `(portal, contextId)` by equality with no fallback in either direction. This is the tenant-isolation invariant; a fallback from a context-scoped request to a context-less grant is the exact bug class the suite exists to prevent.
- **S4 — no deduplication, stable order.** Return every matching grant row; the engine merges scope precedence. Order group grants first, then direct grants, each sorted by policy name, so the merge is deterministic.
- **S5/S15 — real upserts.** Re-syncing a policy must update its `label`, `scopeOptions` and `dependsOn` in place with a stable id. A self-referential SQL upsert that sets columns to themselves fails the suite.
- **S6 — cascading deletes.** `deletePolicies` removes the policies plus every group entry and direct assignment referencing them, atomically to your backend's best capability.
- **S7 — omitted fields keep stored values.** `upsertGroup` with no `isActive` must not reset a stored `false` — that is what lets re-seeding coexist with a runtime kill switch.
- **S10/S13 — idempotent upserts.** Assigning or recording ownership twice leaves one row. Back the upsert with a unique constraint so concurrent calls cannot race into duplicates.
- **S12 — unknown policies throw.** `assignPolicy` throws `UnknownPolicyError` when the qualified name was never synced, instead of creating a grant that no guard would ever match.
- **S18 — missing tables reject.** Every method rejects with an `Error` when the backing tables or collections do not exist, so `rbac sync` can tell users to run migrations instead of silently no-oping.
- **S20 — inactive groups grant nothing.** `getSubjectPolicies` excludes grants from groups whose `isActive` is `false`; direct grants are unaffected.

## Run the contract suite

The suite is the same one the built-in adapters run in CI. It is runner-injected — pass `{ describe, it, expect }` from `bun:test` or Vitest — and calls `makeAdapter` once per case, so every case starts from a clean store:

```ts
// tests/my-adapter.contract.test.ts
import { describe, expect, it } from 'vitest'
import { runStorageAdapterContractSuite } from '@kyrobit/rbac/testing'
import { myAdapter } from '../src/my-adapter.js'

runStorageAdapterContractSuite({
  name: 'my-adapter',
  makeAdapter: async () => {
    const { client, dropDatabase } = await freshDatabase()
    return { adapter: myAdapter(client), cleanup: dropDatabase }
  },
  test: { describe, it, expect },
})
```

Case names carry their clause ids (`S2`, `S10`, ...), so a failure points straight at the clause text in `src/storage/contract.ts`. The in-memory reference implementation, `memoryAdapter()` from `@kyrobit/rbac/testing`, passes the whole suite — when a clause is ambiguous to you, its behavior is the tie-breaker. Full suite options are on the [Testing reference](/reference/testing#runstorageadaptercontractsuite).

::: warning Isolate state per case
`makeAdapter` runs for every case. Returning an adapter over a dirty database makes unrelated clauses fail with confusing diffs — give each call a fresh schema, a fresh collection namespace, or a `cleanup` that truncates.
:::

## Use it

```ts
import { createRbac } from '@kyrobit/rbac'
import { myAdapter } from './my-adapter.js'

const rbac = createRbac({ adapter: myAdapter(client), resources })
```

Everything else — guards, portals, caching, the CLI (point your `rbac.config.ts` adapter factory at `myAdapter`) — works unchanged, because nothing above the adapter knows which backend is underneath. `Scope.owned()` works too: it queries through `adapter.isOwner()`, so implementing the three ownership methods gives you the portable ownership floor. Automatic ownership tracking and query scoping are storage-layer extras; without a backend-specific equivalent of `trackedDb`, applications on your adapter record ownership through [`rbac.ownership.record()`](/reference/core-api#rbac-ownership).

## Next steps

- [Testing reference](/reference/testing) — full options for both contract suites.
- [Core API](/reference/core-api#storageadapter) — the interface and row types, member by member.
- [Database schema](/reference/database-schema) — the constraints the SQL adapters use to satisfy the clauses.
