# Custom adapters

A storage adapter connects the library to a database. Drizzle, Prisma and Mongoose adapters ship in the box. For anything else, implement one interface:

```ts
import type { StorageAdapter } from '@kyrobit/rbac'

const adapter: StorageAdapter = {
  id: 'my-adapter',
  // Optional extras your adapter supports. All false is a valid adapter.
  capabilities: { autoOwnershipTracking: false, queryScoping: false },

  // Policy sync — called by `rbac sync`
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

  // Ownership — powers Scope.owned()
  recordOwnership,
  isOwner,
  removeOwnership,
}
```

Two optional methods: `ensureSchema()` runs before every sync, and `close()` releases connections.

## Implement it, then prove it

The contract suite is the specification. Your adapter is correct exactly when the suite passes:

```ts
import { describe, expect, it } from 'vitest'
import { runStorageAdapterContractSuite } from '@kyrobit/rbac/testing'

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

The exact behavior of every method is documented in the contract source file: [src/storage/contract.ts](https://github.com/KyroBit/rbac/blob/main/src/storage/contract.ts). Each documented rule maps to one case in the suite.

Stuck on what a method should do? `memoryAdapter()` is a complete, readable implementation of the same contract: [src/testing/memory-adapter.ts](https://github.com/KyroBit/rbac/blob/main/src/testing/memory-adapter.ts). Copy its behavior, not its storage.
