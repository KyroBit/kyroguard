# Assigning Users

Once your policies and groups are synced, use these helpers to grant and revoke access. The primary way to assign users is through the portal instance — the portal is already baked in so you can't accidentally assign to the wrong one.

---

## assignGroup

The portal instance returned by `forPortal` has `assignGroup` and `removeGroup` built in:

```ts
// Without a context — user has access to all routes in this portal
await adminRbac.assignGroup(userId, 'ops_manager')

// With a context — user only has access when context_id matches
await branchRbac.assignGroup(userId, 'teller', { contextId: branchId })
```

A user can belong to multiple groups at once. Policies from all active groups are merged at request time. If the same policy appears in multiple groups with different scopes, the least restrictive wins — `null` beats any scope string.

---

## removeGroup

```ts
// Remove with no context
await adminRbac.removeGroup(userId, 'ops_manager')

// Remove a context-specific assignment
await branchRbac.removeGroup(userId, 'teller', { contextId: branchId })
```

Removing a group only removes that specific assignment — it doesn't affect other groups or portals the user belongs to.

---

## assignPolicy

For one-off permissions outside of a group — for example granting a single policy temporarily:

```ts
import { assignPolicy } from '@kyrobit/rbac'

// Unrestricted direct grant
await assignPolicy(db, userId, 'transaction.view')

// With a scope restriction
await assignPolicy(db, userId, 'transaction.void', { scope: 'branch-owned' })
```

Direct policy assignments are merged with group assignments at request time.

---

## removePolicy

```ts
import { removePolicy } from '@kyrobit/rbac'

await removePolicy(db, userId, 'transaction.void')
```

---

## clearPolicyCache

The library caches each user's policy map in memory. After any assignment change, clear the cache so the next request picks up the new state:

```ts
await branchRbac.assignGroup(userId, 'teller', { contextId: branchId })
app.rbac.clearPolicyCache(userId)
```

Clear all entries after a bulk update:

```ts
app.rbac.clearPolicyCache()  // no argument clears everything
```

Always call `clearPolicyCache` after `assignGroup`, `removeGroup`, `assignPolicy`, or `removePolicy`. See [Cache](./cache) for details on how the cache is keyed.

---

**Next:** [Scopes](./scopes)
