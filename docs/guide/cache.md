# Policy Cache

The library caches each user's policy map in memory to avoid a database query on every protected request.

---

## Cache key

Entries are keyed by `subjectId:portal:contextId`. This means:

- The same user in two different portals has two separate cache entries.
- The same user with two different `context_id` values (e.g. branch-1 vs branch-2) has two separate entries.
- Clearing one doesn't affect the other.

---

## When to clear the cache

The cache is not invalidated automatically. Call `clearPolicyCache` after any assignment change so the next request re-fetches from the database:

```ts
await branchRbac.assignGroup(userId, 'teller', { contextId: branchId })
app.rbac.clearPolicyCache(userId)
```

```ts
await branchRbac.removeGroup(userId, 'teller', { contextId: branchId })
app.rbac.clearPolicyCache(userId)
```

```ts
import { assignPolicy } from '@kyrobit/rbac'

await assignPolicy(db, userId, 'transaction.void')
app.rbac.clearPolicyCache(userId)
```

```ts
import { removePolicy } from '@kyrobit/rbac'

await removePolicy(db, userId, 'transaction.void')
app.rbac.clearPolicyCache(userId)
```

---

## Clearing one user vs all users

```ts
// Clear all cache entries for one user (across all portals and contexts)
app.rbac.clearPolicyCache(userId)

// Clear every entry in the cache
app.rbac.clearPolicyCache()
```

Use the no-argument form after bulk updates that affect many users at once.
