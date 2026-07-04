# Scopes

Scopes restrict a policy to a subset of resources. Instead of "this user can void any transaction", a scope makes it "this user can only void transactions belonging to their branch".

Scopes are optional and intended for advanced cases. If your app only needs role-level access control, skip this page.

---

## Ownership tracking

The library needs to know who created each record so scope functions can check it. Wrap your database once at setup — after that, every insert through `db` automatically records the current user and their context:

```ts
// src/db/index.ts
import { createTrackedDb } from '@kyrobit/rbac'
import { resources } from '@/rbac/policies.js'

export const db = createTrackedDb(rawDb, { resources })
```

```ts
// In any route handler — the call site is unchanged
const [txn] = await db
  .insert(transactions)
  .values({ amount: 100, ... })
  .returning()
// The library automatically writes to rbac_resource_owners:
// { resource_type: 'transaction', resource_id: txn.id,
//   owner_id: subject.id, context_id: subject.context_id }
```

**Bypass tracking** — use `db.untracked` for migrations, seeders, and background jobs:

```ts
await db.untracked.insert(transactions).values({ ... })  // no ownership entry written
```

---

## Defining a scope

A scope has a name, a label, and a check function. The check receives the current user, the resource your route provides, and the database instance:

```ts
// src/rbac/scopes.ts
import { Scope, resourceOwners } from '@kyrobit/rbac'
import { eq, and } from 'drizzle-orm'

export const branchOwned = new Scope(
  'branch-owned',
  'Branch Owned',
  async (subject, resource, db) => {
    const rows = await db
      .select({ id: resourceOwners.id })
      .from(resourceOwners)
      .where(and(
        eq(resourceOwners.resource_type, resource.type),
        eq(resourceOwners.resource_id,   resource.id),
        eq(resourceOwners.context_id,    subject.context_id as string),
      ))
      .limit(1)
    return rows.length > 0
  },
)
```

| Parameter | What it contains |
|-----------|-----------------|
| `subject` | The current user — `id`, `context_id`, `is_super`, plus anything else you returned from `forPortal` |
| `resource` | `{ type: string; id: string }` from the route's resource resolver |
| `db` | The raw database instance — use it to query `resourceOwners` or any of your own tables |

The check function can do anything: query the database, check the time, call an external API. Return `true` to allow, `false` to deny.

---

## No extra registration needed

Pass your `Scope` objects directly in `scopeOptions` on each `Policy`. The library reads them from the `db` instance at plugin startup — no extra registration needed:

```ts
await app.register(rbacPlugin, {
  adapter: createDrizzleAdapter(db.untracked),
  db,   // scopes discovered automatically from createTrackedDb
})
```

## Declaring valid scope options on a policy

The fourth argument on `Policy` tells admin UIs which scopes are valid for that policy, and is how the library discovers your scope check functions. Pass the actual `Scope` objects:

```ts
// src/rbac/policies.ts
export const resources: ResourceDefinition[] = [
  {
    table:    transactions,
    type:     'transaction',
    policies: [
      new Policy('transaction.view'),
      new Policy('transaction.void', 'Void', ['transaction.view'], [branchOwned]),
      //                                                             ^^^^^^^^^^^^^^
      //                              scopeOptions — tells admin UIs 'branch-owned' is valid here
    ],
  },
]
```

---

## Using scopes in groups

```ts
export const groups = {
  teller: {
    label: 'Teller',
    policies: {
      'transaction.view': null,           // unrestricted
      'transaction.void': 'branch-owned', // scope check must pass
    },
  },
}
```

`null` means the policy is granted with no restriction. A scope name means the scope function must return `true` before the action is allowed.

---

## Providing a resource resolver on the route

When a route may trigger a scope check, give it a `resource` function so the library knows which record to pass:

```ts
app.post('/transactions/:id/void', {
  preHandler: rbac.requirePolicy('transaction.void', {
    resource: (req) => ({ type: 'transaction', id: req.params.id }),
  }),
}, handler)
```

If the user's assignment is `null` (unrestricted), the resolver is never called — the request passes immediately.

---

## Least restrictive wins

When a user holds the same policy from multiple sources, `null` always wins over any scope string:

```
Teller group:      transaction.void → 'branch-owned'
Direct assignment: transaction.void → null

Effective result: null  (unrestricted — no scope check runs)
```

---

**Next:** [Multi-Tenant](./multi-tenant)
