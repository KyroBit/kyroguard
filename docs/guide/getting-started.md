# Getting Started

This guide walks you through a complete setup — from installation to your first protected route.

---

## 1. Install

```bash
npm install @kyrobit/rbac
# or
bun add @kyrobit/rbac
```

> **Requirements:** Fastify 5+, Drizzle ORM, PostgreSQL.

---

## 2. Add the database tables

The library needs a few tables in your database. Include its schema in your Drizzle config so `drizzle-kit push` creates them:

```ts
// drizzle.config.ts
export default defineConfig({
  schema: [
    './src/db/schema/index.ts',
    './node_modules/@kyrobit/rbac/dist/schema.js',  // [!code ++]
  ],
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

```bash
bunx drizzle-kit push
```

---

## 3. Define your policies

Create a `policies.ts` file. Each `ResourceDefinition` links a Drizzle table to its permissions:

```ts
// src/rbac/policies.ts
import { Policy, type ResourceDefinition } from '@kyrobit/rbac'
import { transactions } from '@/db/schema.js'

export const resources: ResourceDefinition[] = [
  {
    table:    transactions,
    type:     'transaction',
    policies: [
      new Policy('transaction.view'),
      new Policy('transaction.create', 'Create Transaction', ['transaction.view']),
      new Policy('transaction.void',   'Void Transaction',   ['transaction.view']),
    ],
  },
]
```

Policy names use `resource.action` format. The third argument (`dependsOn`) means granting `transaction.create` also automatically grants `transaction.view`.

---

## 4. Define your groups

Groups are bundles of policies — essentially roles. A user assigned to a group inherits all its policies:

```ts
// src/rbac/groups.ts
export const groups = {
  cashier: {
    label:    'Cashier',
    policies: ['transaction.view', 'transaction.create'],
  },
  admin: {
    label:    'Admin',
    policies: 'all',  // every policy in this portal
  },
}
```

---

## 5. Create rbac.config.ts

```ts
// rbac.config.ts  (project root)
export default {
  policies: './src/rbac/policies.ts',
  groups:   './src/rbac/groups.ts',
}
```

---

## 6. Run rbac sync

```bash
bunx rbac sync
```

This pushes your policies and groups to the database, and generates `rbac.d.ts` at the project root. That file contains your `Portal`, `PolicyName`, and `PortalPolicies` types — enabling autocompletion and typo detection everywhere you use the library. Run it on every deploy.

---

## 7. Register the plugin

Register once at app startup:

```ts
// src/plugins/rbac.ts
import { rbacPlugin, createDrizzleAdapter } from '@kyrobit/rbac'
import { db } from '@/db/index.js'

await app.register(rbacPlugin, {
  adapter: createDrizzleAdapter(db),
})
```

---

## 8. Set up forPortal

Call `forPortal` once per portal in each module. It registers the subject resolver for that portal and returns a typed `PortalInstance` with `requirePolicy` and `assignGroup`:

```ts
const rbac = app.rbac.forPortal('admin', (req) => ({
  id: req.user.id,
}))
```

---

## 9. Protect a route

```ts
app.delete('/transactions/:id', {
  preHandler: rbac.requirePolicy('transaction.void'),
}, handler)
```

Anyone without `transaction.void` gets a **403 Forbidden** before your handler runs.

---

## 10. Assign a user to a group

Use the portal instance — the portal name is already baked in:

```ts
// In your user signup or admin controller
await rbac.assignGroup(userId, 'cashier')
app.rbac.clearPolicyCache(userId)
```

On the user's next request, they can view and create transactions.

---

**Next steps:**

- [Policies](./policies) — naming, dependsOn, scopes
- [Groups](./groups) — all formats including scoped assignments
- [Configuration](./configuration) — single vs multi-portal, rbac.d.ts
- [Protecting Routes](./protecting-routes) — scoped routes, response codes
- [Assigning Users](./assigning-users) — removeGroup, assignPolicy, clearPolicyCache
