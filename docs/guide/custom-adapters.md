# Custom adapters

A storage adapter connects the library to a database. Drizzle, Prisma and Mongoose adapters ship in the box. For anything else, implement one interface:

```ts
import type { StorageAdapter } from '@kyrobit/kyroguard'

const adapter: StorageAdapter = {
  id: 'my-adapter',
  // Optional extras your adapter supports. An empty object is a valid adapter.
  capabilities: {},

  // Policy sync — called by `kyroguard sync`
  upsertPolicies,
  listPolicies,
  deletePolicies,

  // Groups
  upsertGroup,
  listGroups,
  getGroupPolicies,
  setGroupPolicies,
  addGroupPolicies,

  // Assignments — who has which group or policy
  assignGroup,
  removeGroup,
  assignPolicy,
  removePolicy,

  // The read path — guards call this on every request
  getSubjectPolicies,
}
```

Two optional methods: `ensureSchema()` runs before every sync, and `close()` releases connections.

An adapter stores grants, not rows of yours: kyroguard keeps no table describing your data. What a grant means for a query is a [scope](/guide/scopes), and scopes are written by the app against its own schema.

## Combining fragments

Set `capabilities.listFiltering` and implement `listFilters` when a subject can hold one policy under two scopes — the engine needs your backend's `OR` to union their fragments, and never assembles a query itself:

```ts
listFilters: {
  or: fragments => ({ $or: fragments }),   // your backend's OR
  none: () => ({ _id: { $in: [] } }),      // a predicate matching nothing
}
```

Without it, two fragments on one policy resolve to `{ kind: 'none', reason: 'unfilterable' }` — an empty list rather than a leak.

## Implement it, then prove it

The contract suite is the specification. Your adapter is correct exactly when the suite passes:

```ts
import { describe, expect, it } from 'vitest'
import { runStorageAdapterContractSuite } from '@kyrobit/kyroguard/testing'

runStorageAdapterContractSuite({
  name: 'my-adapter',
  makeAdapter: async () => {
    const adapter = await connectFreshDatabase()
    return { adapter, cleanup: () => adapter.close() }
  },
  test: { describe, it, expect },
})
```

`makeAdapter` runs once per case, dozens of times. Return a clean database every time. Start with the suite red and work through the failures.

## Where the details live

The exact behavior of every method is documented in the contract source file: [src/storage/contract.ts](https://github.com/KyroBit/kyroguard/blob/main/src/storage/contract.ts). Each documented rule maps to one case in the suite.

Stuck on what a method should do? `memoryAdapter()` is a complete, readable implementation of the same contract: [src/testing/memory-adapter.ts](https://github.com/KyroBit/kyroguard/blob/main/src/testing/memory-adapter.ts). Copy its behavior, not its storage.
