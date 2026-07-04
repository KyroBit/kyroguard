# Example: Multi-Portal

A fintech back-office with two portals: `admin` (headquarters staff managing the platform) and `branch` (day-to-day banking operations scoped per branch). Both portals share one plugin registration but have entirely separate policies, groups, and assignments.

---

## Why two portals?

| | Admin portal | Branch portal |
|---|---|---|
| Who uses it | HQ staff, compliance, ops | Tellers, branch managers |
| `context_id` | None — platform-wide access | Branch ID from the URL |
| Example policy | `user.suspend` | `transaction.void` |

The library enforces each portal separately. A teller's branch assignment has no effect in the admin portal, and an admin group assignment never grants branch permissions.

---

## File structure

```
src/
  rbac/
    admin/
      policies.ts
      groups.ts
    branch/
      policies.ts
      groups.ts
rbac.config.ts
```

---

## Admin policies

```ts
// src/rbac/admin/policies.ts
import { Policy, type ResourceDefinition } from '@kyrobit/rbac'
import { users }    from '@/db/schema/user.js'
import { branches } from '@/db/schema/branch.js'
import { settings } from '@/db/schema/settings.js'

export const adminResources: ResourceDefinition[] = [
  {
    table: users,
    type:  'user',
    policies: [
      new Policy('user.read'),
      new Policy('user.invite',   'Invite User',   ['user.read']),
      new Policy('user.suspend',  'Suspend User',  ['user.read']),
      new Policy('user.delete',   'Delete User',   ['user.read']),
    ],
  },
  {
    table: branches,
    type:  'branch',
    policies: [
      new Policy('branch.read'),
      new Policy('branch.create', 'Create Branch', ['branch.read']),
      new Policy('branch.update', 'Update Branch', ['branch.read']),
      new Policy('branch.close',  'Close Branch',  ['branch.read']),
    ],
  },
  {
    table: settings,
    type:  'settings',
    policies: [
      new Policy('settings.read'),
      new Policy('settings.update', 'Update Settings', ['settings.read']),
    ],
  },
]
```

---

## Admin groups

```ts
// src/rbac/admin/groups.ts
export const adminGroups = {
  compliance_officer: {
    label:    'Compliance Officer',
    policies: ['user.read', 'branch.read', 'settings.read'],
  },
  ops_manager: {
    label: 'Ops Manager',
    policies: [
      'user.read', 'user.invite', 'user.suspend',
      'branch.read', 'branch.create', 'branch.update',
      'settings.read', 'settings.update',
    ],
  },
  super_admin: {
    label:    'Super Admin',
    policies: 'all',
  },
}
```

---

## Branch policies

```ts
// src/rbac/branch/policies.ts
import { Policy, type ResourceDefinition } from '@kyrobit/rbac'
import { transactions } from '@/db/schema/transaction.js'
import { accounts }     from '@/db/schema/account.js'

export const branchResources: ResourceDefinition[] = [
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
  {
    table: accounts,
    type:  'account',
    policies: [
      new Policy('account.view'),
      new Policy('account.open',   'Open Account',   ['account.view']),
      new Policy('account.freeze', 'Freeze Account', ['account.view']),
    ],
  },
]
```

---

## Branch groups

```ts
// src/rbac/branch/groups.ts
export const branchGroups = {
  teller: {
    label:    'Teller',
    policies: ['transaction.view', 'transaction.create', 'account.view'],
  },
  senior_teller: {
    label: 'Senior Teller',
    policies: [
      'transaction.view', 'transaction.create', 'transaction.void',
      'account.view', 'account.open',
    ],
  },
  branch_manager: {
    label:    'Branch Manager',
    policies: 'all',
  },
}
```

---

## Config

```ts
// rbac.config.ts
export default [
  {
    name:     'admin',
    policies: './src/rbac/admin/policies.ts',
    groups:   './src/rbac/admin/groups.ts',
  },
  {
    name:     'branch',
    policies: './src/rbac/branch/policies.ts',
    groups:   './src/rbac/branch/groups.ts',
  },
]
```

```bash
bunx rbac sync
```

---

## Plugin registration

Register once and combine resources from both portals:

```ts
// src/plugins/rbac.ts
import { rbacPlugin, createDrizzleAdapter } from '@kyrobit/rbac'
import { db } from '@/db/index.js'

await app.register(rbacPlugin, {
  adapter: createDrizzleAdapter(db),
})
```

---

## Admin module

Admin has no `context_id` — access is platform-wide:

```ts
// src/modules/admin/index.ts
const adminRbac = app.rbac.forPortal('admin', (req) => ({
  id: req.user.id,
}))

app.get('/admin/users', {
  preHandler: adminRbac.requirePolicy('user.read'),
}, async () => db.select().from(users))

app.post('/admin/users/:id/suspend', {
  preHandler: adminRbac.requirePolicy('user.suspend'),
}, async (req) => {
  await db.update(users).set({ suspended: true }).where(eq(users.id, req.params.id))
  return { ok: true }
})

app.post('/admin/branches', {
  preHandler: adminRbac.requirePolicy('branch.create'),
}, async (req) => {
  const [branch] = await db.insert(branches).values(req.body).returning()
  return branch
})
```

---

## Branch module

The branch portal reads `context_id` from the URL. The library automatically filters assignments to those matching the current branch:

```ts
// src/modules/branch/index.ts
app.register(async (branchApp) => {

  const branchRbac = branchApp.rbac.forPortal('branch', (req) => ({
    id:         req.user.id,
    context_id: req.params.branchId,
  }))

  branchApp.get('/transactions', {
    preHandler: branchRbac.requirePolicy('transaction.view'),
  }, async (req) =>
    db.select().from(transactions).where(eq(transactions.branchId, req.params.branchId))
  )

  branchApp.post('/transactions', {
    preHandler: branchRbac.requirePolicy('transaction.create'),
  }, async (req) => {
    const [txn] = await db.insert(transactions).values({
      ...req.body,
      branchId:  req.params.branchId,
      createdBy: req.user.id,
    }).returning()
    return txn
  })

  branchApp.post('/transactions/:id/void', {
    preHandler: branchRbac.requirePolicy('transaction.void'),
  }, async (req) => {
    await db.update(transactions).set({ voided: true }).where(eq(transactions.id, req.params.id))
    return { ok: true }
  })

}, { prefix: '/branches/:branchId' })
```

---

## Assigning users

Use the portal instance so the portal is always baked in:

```ts
// HQ staff — no context, admin portal only
await adminRbac.assignGroup(userId, 'ops_manager')

// Branch staff — scoped to their specific branch
await branchRbac.assignGroup(userId, 'teller',         { contextId: 'branch-nairobi' })
await branchRbac.assignGroup(userId, 'branch_manager', { contextId: 'branch-mombasa' })
```

---

## Same user in two portals — no conflict

A user can hold assignments in both portals without interference:

```ts
// Alice is an ops_manager in admin and also branch_manager in Nairobi
await adminRbac.assignGroup(alice.id, 'ops_manager')
await branchRbac.assignGroup(alice.id, 'branch_manager', { contextId: 'branch-nairobi' })

// Admin portal request → ops_manager assignment is active
// Branch request for /branches/branch-nairobi/... → branch_manager is active
// Branch request for /branches/branch-mombasa/... → no assignment → 403
```

There is no policy bleed between portals. `transaction.void` exists only in the branch portal; `user.suspend` exists only in the admin portal. Checking `user.suspend` on a branch route always returns 403 regardless of the user's admin assignment.

---

**Next:** [Ownership scope](./own-scope)
