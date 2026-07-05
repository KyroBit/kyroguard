# Writing scopes

A scope narrows a granted policy to specific rows: "can update posts — the ones they own", "can refund orders — in their own branch". On this page you use the built-in ownership scope, write two custom scopes, attach them to policies, and grant them.

::: tip Prerequisites
Policies and syncing are covered in [Portals](/guide/portals); guards and resource resolvers in [Protecting routes](/guide/protecting-routes). Examples use the `branch` portal from those pages.
:::

## How a scoped decision runs

A grant stores either `scope: null` (unrestricted) or a scope name. When a guard hits a scoped grant, the engine:

1. Looks the scope name up in the scope registry (built from your resource definitions).
2. Calls the guard's `resource` resolver to identify the target row.
3. Runs the scope's check function with the subject, the resource, and a context object.

The check returns `true` to allow. Every other outcome — check returns `false`, resource not found, scope not registered, no resolver on the guard — is a deny. A scope is a `Scope` instance:

```ts
import { Scope } from '@kyrobit/rbac'

new Scope(name, label, check)
```

where `check` is a `ScopeCheckFn`:

```ts
type ScopeCheckFn = (
  subject: Subject,          // the authenticated user, with portal/context_id
  resource: ResourceRef,     // { type: 'order', id: 'o1' } from the guard's resolver
  ctx: ScopeCheckContext,    // { db, adapter }
) => boolean | Promise<boolean>
```

`ctx.db` is the database handle you passed to `createRbac({ db })` — untyped by design, since the core cannot know your ORM; cast it to your own db type. `ctx.adapter` is the storage adapter, which powers portable checks like the built-in ownership scope.

## 1. Start with the built-in `Scope.owned()`

`Scope.owned()` allows a subject to act only on resources recorded as theirs in the adapter's ownership store. Because it queries through `ctx.adapter.isOwner()` rather than your tables, it behaves identically on PostgreSQL, MySQL, SQLite and MongoDB:

```ts
// src/rbac/branch/policies.ts
import { Policy, Scope } from '@kyrobit/rbac'
import type { ResourceDefinition } from '@kyrobit/rbac'

export const resources: ResourceDefinition[] = [
  {
    type: 'order',
    policies: [
      new Policy('orders.read'),
      new Policy('orders.update', 'Update orders', ['orders.read'], [Scope.owned()]),
    ],
  },
]
```

Ownership rows come from `rbac.ownership.record()` (or automatically from the tracked db, the Prisma extension or the Mongoose plugin):

```ts
// When an order is created:
const order = await createOrder(input)
await rbac.ownership.record(subject, { type: 'order', id: order.id })
```

## 2. Write a same-branch scope

A custom scope can query your own tables through `ctx.db`. This one allows acting on an order only when it belongs to the subject's current branch — note it compares against `subject.context_id`, the tenant coordinate from [Tenant contexts](/guide/tenant-contexts):

```ts
// src/rbac/scopes.ts
import { Scope } from '@kyrobit/rbac'
import { eq } from 'drizzle-orm'
import { orders } from '../db/schema.js'
import type { db as appDb } from '../db/index.js'

export const sameBranch = new Scope(
  'same-branch',
  'Orders in the user’s branch',
  async (subject, resource, ctx) => {
    const db = ctx.db as typeof appDb
    const [order] = await db
      .select({ branchId: orders.branchId })
      .from(orders)
      .where(eq(orders.id, resource.id))
      .limit(1)
    return order !== undefined && order.branchId === subject.context_id
  },
)
```

For `ctx.db` to be defined here, pass your db handle to `createRbac({ adapter, resources, db })`.

## 3. Write a business-hours scope

A check does not have to touch the resource or the database at all:

```ts
// src/rbac/scopes.ts
export const businessHours = new Scope(
  'business-hours',
  'During business hours (09:00–17:00 UTC)',
  () => {
    const hour = new Date().getUTCHours()
    return hour >= 9 && hour < 17
  },
)
```

Outside the window the check returns `false` and the request is denied — a time-boxed grant with no cron jobs or revocation scripts.

## 4. Register the scopes on their policies

Attach every scope a policy can be granted with to that policy's `scopeOptions` (the fourth `Policy` argument):

```ts
// src/rbac/branch/policies.ts
import { Policy, Scope } from '@kyrobit/rbac'
import { businessHours, sameBranch } from '../scopes.js'
import type { ResourceDefinition } from '@kyrobit/rbac'

export const resources: ResourceDefinition[] = [
  {
    type: 'order',
    policies: [
      new Policy('orders.read'),
      new Policy('orders.update', 'Update orders', ['orders.read'], [Scope.owned(), sameBranch]),
      new Policy('orders.refund', 'Refund orders', ['orders.read'], [sameBranch, businessHours]),
    ],
  },
]
```

`scopeOptions` is where the runtime scope registry comes from: `createRbac({ resources })` collects every scope named in your resource definitions. A grant that names a scope missing from the registry is denied, not ignored — so a scope you forgot to attach can never silently widen a grant to unrestricted.

## 5. Grant a policy with a scope

In a group definition, use the record form — policy name to scope name (`null` = unrestricted):

```ts
// src/rbac/branch/groups.ts
import type { GroupsDefinition } from '@kyrobit/rbac'

export const groups: GroupsDefinition = {
  cashier: {
    label: 'Cashier',
    policies: {
      'orders.read': null,               // unrestricted
      'orders.update': 'owned',          // only orders they recorded
      'orders.refund': 'business-hours', // only 09:00–17:00 UTC
    },
  },
  manager: {
    label: 'Branch manager',
    policies: {
      'orders.read': null,
      'orders.update': 'same-branch',
      'orders.refund': 'same-branch',
    },
  },
}
```

Direct assignments take the scope as an option:

```ts
await branch.assignPolicy('user-42', 'orders.refund', {
  contextId: 'branch-1',
  scope: 'same-branch',
})
```

Run `npx rbac sync` after changing policies or groups.

If duplicate grants of one policy reach a subject — say, one group grants `orders.update` scoped `owned` and another grants it unrestricted — the unrestricted grant wins. A scope narrows a grant, so the widest grant the subject legitimately holds is the one that applies.

## 6. Give the guard a resource resolver

A scoped grant needs to know which row is being touched, so the guard must resolve the target:

```ts
app.post(
  '/branch/orders/:id/refund',
  {
    preHandler: branch.requirePolicy('orders.refund', {
      resource: request => ({
        type: 'order',
        id: (request.params as { id: string }).id,
      }),
    }),
  },
  async request => refundOrder((request.params as { id: string }).id),
)
```

The resolver may also load the row and return `null` when it does not exist.

## Failure modes, exactly

For a cashier granted `orders.refund` with scope `business-hours`, calling the route at 20:00 UTC returns `403`:

```json
{
  "message": "Forbidden",
  "code": "RBAC_SCOPE_DENIED"
}
```

If the resolver returns `null` or `undefined` (row does not exist), the response is `404`:

```json
{
  "message": "Not found",
  "code": "RBAC_RESOURCE_NOT_FOUND"
}
```

The guard answers with the 404 itself because it resolves the resource before your handler runs — a scoped check cannot proceed without a row, and pretending the check passed would let requests for nonexistent rows through. An unscoped denial (`RBAC_POLICY_DENIED`) and all other codes are listed in the [error reference](/reference/errors).

::: danger A scoped grant with no resolver is a deny
If a grant carries a scope but the guard has no `resource` resolver — or the scope name is not in the registry — the request is denied with `RBAC_SCOPE_DENIED`, even for a scope like `business-hours` whose check ignores the resource. The engine cannot run a row-level check without a row to check, and treating that as "allow" would turn every missing resolver into an unrestricted grant. Failing closed means the mistake surfaces as a loud 403 in development instead of a silent privilege escalation in production. When a scoped route unexpectedly returns `RBAC_SCOPE_DENIED` for a user who should pass, check first that the guard passes `resource` and that the scope is attached to the policy's `scopeOptions`.
:::

## Next steps

- [Assigning access](/guide/assigning-access) — how scoped grants are stored and revoked
- [Protecting routes](/guide/protecting-routes) — guard options and error handling in depth
- [Super users](/guide/super-users) — the one flag that skips scope checks entirely
