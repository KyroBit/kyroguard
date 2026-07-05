# Assigning access

Hiring a cashier for branch-1 is one call:

```ts
await branch.assignGroup(user.id, 'cashier', { tenantId: 'branch-1' })
```

This makes the user a cashier in branch-1, on the `branch` domain. Most apps only need `assignGroup` and `assignPolicy` on a domain.

```ts
// a single policy instead of a job title
await branch.assignPolicy(user.id, 'products.update')

// scoped: only sales the user rang up
await branch.assignPolicy(user.id, 'sales.void', { scope: 'owned' })

// a promotion, valid in one store only
await branch.assignGroup(user.id, 'manager', { tenantId: 'branch-1' })
```

Policy names stay short — the domain adds its prefix ([Multi-tenancy](/guide/multi-tenancy)). Groups and policies must exist before you assign them. See [Groups](/guide/groups) and [Sync](/guide/sync).

Removal mirrors assignment. Someone leaves, you take the job title back:

```ts
await branch.removeGroup(user.id, 'cashier', { tenantId: 'branch-1' })
await branch.removePolicy(user.id, 'products.update')
```

Assigning twice is safe. The second call does nothing.

Changes apply immediately on this server. Running several servers? See [Production](/guide/production).

## Scripts and admin panels

Outside a request handler there is often no domain instance. Use `rbac.admin.*` there:

```ts
import { rbac } from './rbac.js'

await rbac.admin.assignGroup(
  { subjectId: 'user-42', domain: 'branch', tenantId: 'branch-1' },
  'cashier',
)

await rbac.admin.assignPolicy(
  { subjectId: 'user-42', domain: 'branch', tenantId: 'branch-1' },
  'branch.sales.view',
)
```

Same operations, made explicit. `rbac.admin` takes full policy names like `branch.sales.view`. Domain instances add the prefix for you. This API does not.

## Owners

Roles cover the staff. The person the branch belongs to is different — an owner passes every check in their own tenant without holding a single policy. That is `is_super`, and it has its own page: [Owners and superusers](/guide/owners).
