# Identifying the Current User

`forPortal` is how you tell the library who is making a request. Call it once per portal in each module. It registers an `onRequest` hook, binds the portal name, and returns a typed `PortalInstance` with `requirePolicy`, `assignGroup`, and `removeGroup`.

```ts
const rbac = app.rbac.forPortal(portalName, (req) => subject)
```

---

## Simple app (single portal)

```ts
// src/app.ts
const rbac = app.rbac.forPortal('admin', (req) => ({
  id: req.user.id,
}))

app.get('/dashboard', { preHandler: rbac.requirePolicy('dashboard.view') }, handler)
app.delete('/users/:id', { preHandler: rbac.requirePolicy('user.delete') }, handler)
```

---

## Multi-portal app

Each module calls `forPortal` independently with its own portal name and subject logic:

```ts
// Admin module — no context, platform-wide access
const adminRbac = adminApp.rbac.forPortal('admin', (req) => ({
  id: req.user.id,
}))

adminApp.get('/settings', {
  preHandler: adminRbac.requirePolicy('settings.manage'),
}, handler)
```

```ts
// Branch module — context comes from the URL
const branchRbac = branchApp.rbac.forPortal('branch', (req) => ({
  id:         req.user.id,
  context_id: req.params.branchId,
}))

branchApp.get('/transactions', {
  preHandler: branchRbac.requirePolicy('transaction.view'),
}, handler)
```

```ts
// Cashier module — context is the terminal ID
const cashierRbac = cashierApp.rbac.forPortal('cashier', (req) => ({
  id:         req.user.id,
  context_id: req.params.terminalId,
}))

cashierApp.get('/sales', {
  preHandler: cashierRbac.requirePolicy('sale.create'),
}, handler)
```

---

## Subject fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Required. The authenticated user's ID. |
| `context_id` | `string` | Optional. The active branch, tenant, or terminal. When present, the library loads only group assignments that match this exact context. |
| `is_super` | `boolean` | Optional. When `true`, all `requirePolicy` checks are bypassed. The library doesn't define what "super" means — your app decides. |

---

## is_super

Return `is_super: true` from the callback when your condition is met. Each portal decides independently:

```ts
// Admin — super if the user has the global flag
const adminRbac = adminApp.rbac.forPortal('admin', async (req) => ({
  id:       req.user.id,
  is_super: req.user.isSuperAdmin,
}))

// Branch — super if the user owns that specific branch
const branchRbac = branchApp.rbac.forPortal('branch', async (req) => ({
  id:         req.user.id,
  context_id: req.params.branchId,
  is_super:   req.user.ownedBranches.includes(req.params.branchId),
}))
```

See [is_super](./is-super) for a full breakdown of what it bypasses.

---

> `req.user` is not a Fastify built-in — replace it with wherever your app stores the authenticated user (JWT plugin, session, etc.).

---

**Next:** [Protecting Routes](./protecting-routes)
