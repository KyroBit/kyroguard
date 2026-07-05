# Portals

A portal is one face of your application: the admin panel, the branch dashboard, the customer app. On this page you declare two portals, give each its own policy namespace, and confirm that a grant in one portal never satisfies a route in another.

::: tip Prerequisites
This page assumes a working `createRbac()` setup from [Installation](/guide/installation) and guard basics from [Protecting routes](/guide/protecting-routes).
:::

## What a portal is

Most applications serve more than one audience from one codebase — staff in an admin panel, branch employees in a branch dashboard, customers in a public app. A portal models one of those faces. Each portal owns three things:

- **A policy namespace.** Policies synced under a portal are stored with the portal's name as a prefix, so `orders.read` in the `branch` portal and a hypothetical `orders.read` in the `admin` portal are different policies.
- **Its own assignments.** Every group and policy assignment carries the portal it was made for, and grants are matched to requests by strict equality on that portal name. A user who is an editor in `admin` holds nothing in `branch`.
- **Its own subject resolution.** Each portal has its own `getSubject` function, so the admin panel can authenticate with staff sessions while the customer app uses JWTs — on the same server.

### How policy names are qualified

When you write `new Policy('orders.read')` in the branch portal's policy file, storage records it as `branch.orders.read`. The rule is `qualifyPolicyName(portal, name)`: the portal name, a dot, the unqualified name.

Exactly one layer qualifies names — the engine. Portal guards and the portal assignment sugar take unqualified names (`'orders.read'`) and add the prefix for you; the low-level `rbac.admin` API takes already-qualified names (`'branch.orders.read'`) and says so in its signature. You never concatenate prefixes in route code, which is what prevents a typo like `branch.branch.orders.read` from silently granting nothing. See [Assigning access](/guide/assigning-access) for both APIs.

If your app has a single face, omit the portal name entirely: the empty-string sentinel `''` means "no portal", and policy names stay unqualified.

## 1. Declare the portals in `rbac.config.ts`

Each portal points at its own policies module (and optionally a groups module):

```ts
// rbac.config.ts
import { defineConfig } from '@kyrobit/rbac'

export default defineConfig({
  adapter: async () => {
    const { drizzleAdapter } = await import('@kyrobit/rbac/drizzle')
    const schema = await import('./src/db/rbac-schema.js')
    const { db } = await import('./src/db/index.js')
    return drizzleAdapter(db, { schema })
  },
  portals: [
    { name: 'admin',  policies: './src/rbac/admin/policies.ts',  groups: './src/rbac/admin/groups.ts' },
    { name: 'branch', policies: './src/rbac/branch/policies.ts', groups: './src/rbac/branch/groups.ts' },
  ],
  typegen: { output: './rbac.d.ts' },
})
```

## 2. Define each portal's policies

Policy names are unqualified inside a portal's file — the sync step adds the `admin.` / `branch.` prefix:

```ts
// src/rbac/admin/policies.ts
import { Policy } from '@kyrobit/rbac'
import type { ResourceDefinition } from '@kyrobit/rbac'

export const resources: ResourceDefinition[] = [
  {
    type: 'product',
    policies: [
      new Policy('products.read'),
      new Policy('products.update', 'Update products', ['products.read']),
    ],
  },
]
```

```ts
// src/rbac/branch/policies.ts
import { Policy } from '@kyrobit/rbac'
import type { ResourceDefinition } from '@kyrobit/rbac'

export const resources: ResourceDefinition[] = [
  {
    type: 'order',
    policies: [
      new Policy('orders.read'),
      new Policy('orders.refund', 'Refund orders', ['orders.read']),
    ],
  },
]
```

::: warning Group names are global, not per-portal
Groups are stored by name alone; only their policy entries carry portal prefixes, and seeding replaces a group's entries wholesale. If both `admin/groups.ts` and `branch/groups.ts` define a group named `manager`, the portal synced last overwrites the other's entries. Give groups portal-distinct names (`admin-manager`, `branch-manager`) when portals need similar roles.
:::

## 3. Sync

```bash
npx rbac sync
```

`rbac sync` upserts each portal's policies under its prefix, seeds each portal's groups, and writes `rbac.d.ts` (see [Typed portal names](#typed-portal-names) below). Orphan cleanup is filtered on the stored portal column, so re-syncing the `admin` portal can never delete `branch` policies.

## 4. Create portal instances in your app

One app hosts several portals safely: registering a portal never installs an app-wide hook. Each guard resolves its portal's subject lazily at guard time and memoizes it per request per portal, so two portals on one server cannot overwrite each other's subject.

::: code-group

```ts [Fastify]
// src/server.ts
import Fastify from 'fastify'
import { createRbac } from '@kyrobit/rbac'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from './db/rbac-schema.js'
import { db } from './db/index.js'
import { resources as adminResources } from './rbac/admin/policies.js'
import { resources as branchResources } from './rbac/branch/policies.js'

const app = Fastify()
const rbac = createRbac({
  adapter: drizzleAdapter(db, { schema }),
  resources: [...adminResources, ...branchResources],
  db,
})

await app.register(rbacFastify(rbac))

const admin = app.rbac.portal('admin', {
  getSubject: async request => {
    const staff = await resolveStaffSession(request) // your auth
    return staff ? { id: staff.id } : null
  },
})

const branch = app.rbac.portal('branch', {
  getSubject: async request => {
    const user = await resolveUserToken(request) // your auth
    return user ? { id: user.id } : null
  },
})

app.get(
  '/admin/products',
  { preHandler: admin.requirePolicy('products.read') },
  async () => listProducts(),
)

app.get(
  '/branch/orders',
  { preHandler: branch.requirePolicy('orders.read') },
  async () => listOrders(),
)

await app.listen({ port: 3000 })
```

```ts [Express]
// src/server.ts
import express from 'express'
import { createRbac } from '@kyrobit/rbac'
import { rbacExpress } from '@kyrobit/rbac/express'
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from './db/rbac-schema.js'
import { db } from './db/index.js'
import { resources as adminResources } from './rbac/admin/policies.js'
import { resources as branchResources } from './rbac/branch/policies.js'

const app = express()
const rbac = createRbac({
  adapter: drizzleAdapter(db, { schema }),
  resources: [...adminResources, ...branchResources],
  db,
})

const guards = rbacExpress(rbac)
app.use(guards.context()) // opens the per-request context — register before any guard

const admin = guards.portal('admin', {
  getSubject: async req => {
    const staff = await resolveStaffSession(req) // your auth
    return staff ? { id: staff.id } : null
  },
})

const branch = guards.portal('branch', {
  getSubject: async req => {
    const user = await resolveUserToken(req) // your auth
    return user ? { id: user.id } : null
  },
})

app.get('/admin/products', admin.requirePolicy('products.read'), (_req, res) => {
  res.json(listProducts())
})

app.get('/branch/orders', branch.requirePolicy('orders.read'), (_req, res) => {
  res.json(listOrders())
})

app.use(guards.errorHandler()) // renders RbacErrors; delegates everything else

app.listen(3000)
```

:::

## 5. Verify the isolation

Grant a user access in the `admin` portal only:

```ts
await admin.assignPolicy('user-42', 'products.read')
```

A request from `user-42` to `/admin/products` returns `200`. The same user calling `/branch/orders` is denied with `403` and this body:

```json
{
  "message": "Forbidden",
  "code": "RBAC_POLICY_DENIED"
}
```

The grant is stored for portal `admin` and the route asked for portal `branch`; portals are matched by strict equality, so the grant does not apply. There is no fallback across portals — a customer-portal grant leaking into the admin panel would be a privilege escalation, so the engine never looks outside the requesting portal. (Fastify's default error serializer wraps the same `code` and `message` with `statusCode` and `error` fields; the `code` value is the stable contract — see the [error reference](/reference/errors).)

## Typed portal names

`rbac sync` (and the database-free `rbac generate`) writes `rbac.d.ts`, which augments the `RbacTypes` interface exported by `@kyrobit/rbac`:

```ts
// rbac.d.ts — generated, do not edit
export {}

declare module '@kyrobit/rbac' {
  interface RbacTypes {
    Portal: "admin" | "branch"
    PolicyName: "orders.read" | "orders.refund" | "products.read" | "products.update"
    PortalPolicies: {
      "admin": "products.read" | "products.update"
      "branch": "orders.read" | "orders.refund"
    }
  }
}
```

With this file in your `tsconfig` include set, `requirePolicy` and the assignment sugar accept only that portal's policy names — `admin.requirePolicy('orders.refund')` is a compile error, because `orders.refund` exists only in the `branch` portal. The `PortalName` type (import it from `@kyrobit/rbac`) resolves to `'admin' | 'branch'` for use in your own signatures. Before augmentation all three types fall back to `string`, so the package works untyped and tightens as soon as you sync.

## Next steps

- [Tenant contexts](/guide/tenant-contexts) — scope assignments to a branch or tenant inside a portal
- [Assigning access](/guide/assigning-access) — portal sugar vs the fully-qualified admin API
- [Writing scopes](/guide/writing-scopes) — restrict a granted policy to specific rows
