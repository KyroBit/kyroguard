# Assigning access

Grants connect a user to a group or a single policy at exact `(portal, context)` coordinates. On this page you assign and revoke access through both APIs — the portal instance sugar and the low-level `rbac.admin` API — and learn what happens to caches when you do.

::: tip Prerequisites
You need synced policies and groups from [Portals](/guide/portals), and [Tenant contexts](/guide/tenant-contexts) explains the `contextId` option used throughout.
:::

## Two APIs, one rule

| | Portal instance sugar | `rbac.admin.*` |
| --- | --- | --- |
| Policy names | Unqualified (`'orders.refund'`) — the portal adds its prefix | Fully qualified (`'branch.orders.refund'`) |
| Portal | Fixed to the portal instance | Explicit per call |
| Context | `{ contextId }` option | Explicit per call |
| Use it in | Route handlers of that portal | Admin panels, seed scripts, cross-portal tooling |

Both call the same engine methods underneath; the sugar exists so route code cannot mis-qualify a name, and `rbac.admin` exists so a script or an admin panel can operate on any portal without holding portal instances.

## 1. Grant through the portal instance

Inside an app that already has a `branch` portal instance:

```ts
// A branch-portal route that promotes a user to manager of the caller's branch
app.post(
  '/branch/staff/:userId/promote',
  { preHandler: branch.requirePolicy('staff.manage') },
  async request => {
    const { userId } = request.params as { userId: string }
    const branchId = request.headers['x-branch-id'] as string

    await branch.assignGroup(userId, 'manager', { contextId: branchId })
    return { promoted: true }
  },
)
```

The sugar covers all four mutations, always for this portal:

```ts
await branch.assignGroup('user-42', 'manager', { contextId: 'branch-2' })
await branch.removeGroup('user-42', 'manager', { contextId: 'branch-2' })

// Direct policy grants take an optional scope (see Writing scopes):
await branch.assignPolicy('user-42', 'orders.refund', { contextId: 'branch-1', scope: 'owned' })
await branch.removePolicy('user-42', 'orders.refund', { contextId: 'branch-1' })
```

Omitting `contextId` stores the grant at the "no context" sentinel — it then applies only to requests whose subject has no `context_id`.

## 2. Grant through `rbac.admin`

`rbac.admin` takes an explicit subject reference and fully-qualified policy names. It is the right layer for seed scripts and admin backends that manage several portals:

```ts
// scripts/seed-staff.ts
import { createRbac } from '@kyrobit/rbac'
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from '../src/db/rbac-schema.js'
import { db } from '../src/db/index.js'

const rbac = createRbac({ adapter: drizzleAdapter(db, { schema }) })

// Group assignment: group names are unqualified (groups are global by name).
await rbac.admin.assignGroup(
  { subjectId: 'user-42', portal: 'branch', contextId: 'branch-1' },
  'cashier',
)

// Direct policy assignment: the policy name is FULLY QUALIFIED here.
await rbac.admin.assignPolicy(
  { subjectId: 'user-42', portal: 'branch', contextId: 'branch-1' },
  'branch.orders.refund',
  null, // scope: null = unrestricted; a scope name restricts the grant
)

rbac.dispose()
```

Omitting `portal` or `contextId` in the reference means "none" (the `''` sentinel). If you prefer not to hand-write prefixes, build them with the exported helper:

```ts
import { qualifyPolicyName } from '@kyrobit/rbac'

qualifyPolicyName('branch', 'orders.refund') // 'branch.orders.refund'
```

::: warning Sync before you assign
`assignPolicy` throws `UnknownPolicyError` when the qualified policy is not in storage, and `assignGroup` rejects with `Policy group "…" not found — seed groups first` when the group has not been seeded. Assignments never create their target as a side effect, because a misspelled name would otherwise become a permanent grant that no guard ever matches. Run `npx rbac sync` (or `rbac.sync()` / `rbac.seedGroups()`) before any script that assigns access.
:::

## 3. Remove access

Removal takes the same coordinates as assignment and removes only the row matching the exact `(subject, target, portal, contextId)` tuple:

```ts
await branch.removeGroup('user-42', 'manager', { contextId: 'branch-2' })
```

Removing `manager` at `branch-2` leaves the same user's `cashier` grant at `branch-1` untouched. There is no wildcard removal — revoking "everywhere" means enumerating the contexts you granted, which keeps revocation as explicit as the grants were.

After removal, the next authorized request is denied with `403`:

```json
{
  "message": "Forbidden",
  "code": "RBAC_POLICY_DENIED"
}
```

## Assigning twice is safe

All four mutations are idempotent upserts against a unique constraint on `(subject, target, portal, contextId)` — calling `assignGroup` twice leaves one row, and re-running a seed script converges instead of accumulating duplicates. Removing a grant that does not exist is a no-op. This is storage-contract clause S10, enforced by the adapter test suite on every backend, so you can write idempotent onboarding and seed code without existence checks.

## What happens to caches when you mutate

Every assignment mutation does two things after the storage write, unconditionally:

1. **Invalidates the local policy cache** for that subject — every cached policy map of that user, across all portals and contexts, is dropped in this process.
2. **Publishes on the invalidation bus** (`{ type: 'subject', subjectId }`), so other subscribed processes drop their entries too.

Within the process that performed the mutation, the very next request sees the new grants — the framework contract suite verifies grant → allow → revoke → deny with no restart in between.

## Revocation latency across instances

How fast a revocation reaches *other* server instances depends on your bus:

- **Default in-process bus:** other instances never hear the invalidation. They serve the stale policy map until their cache entry's TTL expires — 30 seconds with the default in-memory cache. Revocation latency is bounded by the TTL, not unbounded, because entries always expire.
- **`redisBus` (from `@kyrobit/rbac/cache`):** the mutation is published over Redis pub/sub and every instance invalidates immediately. The TTL remains the backstop if a message is lost — Redis pub/sub is fire-and-forget.

Size the TTL to the longest staleness you accept for a revoked grant, and use a shared bus in any multi-instance deployment where "must lose access now" matters. Setup for both is on the [caching page](/guide/caching).

## Next steps

- [Caching](/guide/caching) — TTL tuning, the Redis bus, and cache observability hooks
- [Writing scopes](/guide/writing-scopes) — grant a policy restricted to specific rows
- [Tenant contexts](/guide/tenant-contexts) — what the `contextId` coordinate means
