# Introduction

@kyrobit/rbac answers one question on every request: is this staff member allowed to do this?

The docs run one example: the staff back office of a hardware-store chain. RBAC governs staff. Customers never log in.

Here is the whole library in one file:

```ts
import Fastify from 'fastify'
import { createRbac, Policy } from '@kyrobit/rbac'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { memoryAdapter } from '@kyrobit/rbac/testing' // in-memory store, no database

// A policy is a named permission — one thing staff can do
const policies = [new Policy('sales.view')]

// A group is a job title
const groups = { cashier: { label: 'Cashier', policies: ['sales.view'] } }

// One rbac instance for the whole app
const rbac = createRbac({ adapter: memoryAdapter(), policies, groups })
await rbac.sync() // loads the policies and the groups

const app = Fastify()
await app.register(rbacFastify(rbac))

// A domain turns a request into a staff member
const staff = app.rbac.domain({
  getSubject: async req => ({ id: req.headers['x-user-id'] as string }),
})

// Guard a route
app.get('/sales', { preHandler: staff.requirePolicy('sales.view') }, async () => [])

// Hire someone: assign the cashier group
await staff.assignGroup('user-1', 'cashier')
```

This file is a sketch, not a runnable app.

You define policies in code. You assign them to staff in the database. Guards enforce them on routes. The [quick start](/guide/quick-start) turns this into a running server in five minutes.

## The pieces

Six words cover everything this library does.

- **Policy** — a named permission, like `sales.view`: one thing staff can do. See [Policies](/guide/policies).
- **Group** — a job title, like `cashier`: its policies, assigned as one. See [Groups](/guide/groups).
- **Domain** — the app staff sign in to: `admin` (head office) or `branch` (in-store). See [Multi-tenancy](/guide/multi-tenancy).
- **Tenant** — the store a grant applies to, like `branch-1`. See [Multi-tenancy](/guide/multi-tenancy).
- **Scope** — a condition on a permission: a cashier voids only their own sales, only under 5,000, only during opening hours. See [Scopes](/guide/scopes).
- **Subject** — the logged-in staff member, as this library sees it. See [Protecting routes](/guide/protecting-routes).

## How a request flows

1. A request hits a guarded route.
2. The guard calls your `getSubject` to resolve the staff member. No one means 401.
3. The engine looks up their policies. Missing policy means 403.
4. If the policy is scoped, the scope checks the target row. A failed check means 403.
5. Your handler runs.

## Next

- [Quick start](/guide/quick-start) — a running server in five minutes, no database.
- [Installation](/guide/installation) — wire up your real database and framework.
