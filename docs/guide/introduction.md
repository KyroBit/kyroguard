# Introduction

`@kyrobit/rbac` is a role-based access control library built for Fastify and Drizzle ORM. You define what actions exist in your app, bundle those actions into groups, assign groups to users, and protect routes — all with full TypeScript safety generated from your config.

---

## Core concepts

| Concept | What it is |
|---------|------------|
| **Policy** | A single named permission, like `transaction.view`. The smallest unit of access. |
| **Group** | A named set of policies — essentially a role. Users gain permissions through group membership. |
| **Portal** | An isolated policy namespace. Each section of your app (admin, branch, cashier) is its own portal with its own policies and groups. |
| **Subject** | The current user on a request: their `id`, an optional `context_id`, and whether they are `is_super`. |
| **Context** | An optional tenant or branch identifier. Assignments can be scoped to a context so the same user can have different permissions in different branches. |
| **Scope** | An optional filter on a policy — "can void transactions, but only those belonging to their branch". Evaluated at request time against the specific resource. |

---

## How the pieces fit together

```
rbac.config.ts
  └── portal: "branch"
        ├── policies (ResourceDefinition[])
        │     transaction.view, transaction.create, transaction.void
        └── groups
              teller → { transaction.view, transaction.create }
                                  │
                    branchRbac.assignGroup(userId, 'teller', { contextId: 'branch-1' })
                                  │
                      request hits /branches/branch-1/transactions
                                  │
          forPortal('branch', req => ({ id: req.user.id, context_id: req.params.branchId }))
                                  │
                  rbac.requirePolicy('transaction.view')  →  ✓ or 403
```

You define policies and groups in code, run `rbac sync` to push them to the database and generate TypeScript types, then use `requirePolicy` to protect routes.

---

## What `rbac sync` generates

After syncing, a `rbac.d.ts` file appears at the project root. It gives you full autocompletion:

- Passing a typo to `forPortal('branchh')` is a TypeScript error.
- Passing a typo to `requirePolicy('transacton.view')` is a TypeScript error.
- Each portal instance only accepts its own policy names.

---

**Next:** [Getting Started](./getting-started)
