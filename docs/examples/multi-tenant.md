# Example: Multi-Tenant Branch System

A banking app where one user can work in multiple branches, each with a different role. Access is completely isolated per branch — what you can do in branch-a has no bearing on what you can do in branch-b.

---

## Scenario

David is a `branch_manager` in branch-a and a `branch_teller` in branch-b.

- `GET /branches/branch-a/transactions` → uses his branch_manager assignment → allowed
- `GET /branches/branch-b/transactions` → uses his branch_teller assignment → allowed
- `POST /branches/branch-b/transactions/void` → branch_teller can't void → 403

---

## Policies

```ts
// src/rbac/policies.ts
import { Policy, type ResourceDefinition } from '@kyrobit/rbac'
import { transactions } from '@/db/schema.js'

export const resources: ResourceDefinition[] = [
  {
    table: transactions,
    type:  'transaction',
    policies: [
      new Policy('transaction.view'),
      new Policy('transaction.create',  'Create Transaction',  ['transaction.view']),
      new Policy('transaction.void',    'Void Transaction',    ['transaction.view']),
      new Policy('transaction.approve', 'Approve Transaction', ['transaction.view']),
    ],
  },
]
```

---

## Groups

```ts
// src/rbac/groups.ts
export const groups = {
  branch_manager: {
    label:    'Branch Manager',
    policies: 'all',
  },
  branch_teller: {
    label:    'Branch Teller',
    policies: ['transaction.view', 'transaction.create'],
  },
}
```

---

## Config

```ts
// rbac.config.ts
export default {
  policies: './src/rbac/policies.ts',
  groups:   './src/rbac/groups.ts',
}
```

---

## Plugin registration

```ts
// src/plugins/rbac.ts
import { rbacPlugin, createDrizzleAdapter } from '@kyrobit/rbac'
import { db } from '@/db/index.js'

await app.register(rbacPlugin, {
  adapter: createDrizzleAdapter(db),
})
```

---

## forPortal

The branch portal reads `context_id` from the URL. The library loads only the assignment matching the exact branch:

```ts
app.register(async (branchApp) => {

  const branchRbac = branchApp.rbac.forPortal('branch', (req) => ({
    id:         req.user.id,
    context_id: req.params.branchId,
  }))

  branchApp.get('/transactions', {
    preHandler: branchRbac.requirePolicy('transaction.view'),
  }, handler)

  branchApp.post('/transactions', {
    preHandler: branchRbac.requirePolicy('transaction.create'),
  }, handler)

  branchApp.post('/transactions/:id/void', {
    preHandler: branchRbac.requirePolicy('transaction.void'),
  }, handler)

}, { prefix: '/branches/:branchId' })
```

---

## Assigning David

```ts
// David is a manager in branch-a and a teller in branch-b
await branchRbac.assignGroup(david.id, 'branch_manager', { contextId: 'branch-a' })
await branchRbac.assignGroup(david.id, 'branch_teller',  { contextId: 'branch-b' })
app.rbac.clearPolicyCache(david.id)
```

---

## Policy matrix for David

| Policy | branch-a (manager) | branch-b (teller) |
|--------|--------------------|--------------------|
| `transaction.view` | ✓ | ✓ |
| `transaction.create` | ✓ | ✓ |
| `transaction.void` | ✓ | ✗ 403 |
| `transaction.approve` | ✓ | ✗ 403 |

When David hits `/branches/branch-a/...`, only his `branch_manager` assignment (contextId = branch-a) is active. When he hits `/branches/branch-b/...`, only his `branch_teller` assignment (contextId = branch-b) is active.

---

## Full request trace

```
POST /branches/branch-a/transactions/void  (David)
  → context_id = 'branch-a'
  → loads: branch_manager (context: branch-a)
  → branch_manager has transaction.void → 200 OK

POST /branches/branch-b/transactions/void  (David)
  → context_id = 'branch-b'
  → loads: branch_teller (context: branch-b)
  → branch_teller does not have transaction.void → 403 Forbidden

POST /branches/branch-c/transactions  (David)
  → context_id = 'branch-c'
  → no assignment for branch-c → 403 Forbidden
```
