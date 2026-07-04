# Multi-Tenant & Multi-Portal

---

## Portal isolation

Each call to `forPortal` creates an isolated enforcement context. Policies are looked up only within the portal the request belongs to. Two routes in different portals can share the same policy name — they are completely independent.

```
Request → /admin/...        → forPortal('admin', ...)  → admin policies
Request → /branches/1/...   → forPortal('branch', ...) → branch policies, context: '1'
Request → /branches/2/...   → forPortal('branch', ...) → branch policies, context: '2'
```

---

## context_id isolation

`context_id` filters which group assignments apply to a request. The match is exact — a user assigned as `teller` in branch-1 gets no permissions when their context is branch-2.

There is no fallback. If a user has no assignment matching the exact portal + context combination, they get 403.

---

## Same user in multiple portals

A user can hold assignments in different portals without any interference. Each portal sees only its own assignments:

```ts
// Assign to admin portal (no context — admin is platform-wide)
await adminRbac.assignGroup(userId, 'ops_manager')

// Assign to branch portal, scoped to branch-1
await branchRbac.assignGroup(userId, 'branch_manager', { contextId: 'branch-1' })
```

```ts
// Admin module — reads from admin portal
app.register(async (adminApp) => {
  const adminRbac = adminApp.rbac.forPortal('admin', (req) => ({
    id: req.user.id,
  }))

  adminApp.get('/dashboard', {
    preHandler: adminRbac.requirePolicy('dashboard.view'),
  }, handler)
}, { prefix: '/admin' })
```

```ts
// Branch module — reads from branch portal with context
app.register(async (branchApp) => {
  const branchRbac = branchApp.rbac.forPortal('branch', (req) => ({
    id:         req.user.id,
    context_id: req.params.branchId,
  }))

  branchApp.get('/overview', {
    preHandler: branchRbac.requirePolicy('branch.view'),
  }, handler)
}, { prefix: '/branches/:branchId' })
```

| Request | Portal | context_id | Assignment loaded |
|---------|--------|------------|-------------------|
| `GET /admin/dashboard` | `admin` | — | ops_manager (portal: admin) |
| `GET /branches/1/overview` | `branch` | `'1'` | branch_manager (context: 1) |
| `GET /branches/2/overview` | `branch` | `'2'` | none → 403 |

Admin assignments never apply on branch routes. Branch assignments never apply on admin routes.

---

## Three-portal example (admin + branch + cashier)

**Config:**

```ts
// rbac.config.ts
export default [
  { name: 'admin',   policies: './src/rbac/admin/policies.ts',   groups: './src/rbac/admin/groups.ts' },
  { name: 'branch',  policies: './src/rbac/branch/policies.ts',  groups: './src/rbac/branch/groups.ts' },
  { name: 'cashier', policies: './src/rbac/cashier/policies.ts', groups: './src/rbac/cashier/groups.ts' },
]
```

**forPortal calls:**

```ts
// Admin module
const adminRbac = adminApp.rbac.forPortal('admin', (req) => ({
  id: req.user.id,
}))

// Branch module
const branchRbac = branchApp.rbac.forPortal('branch', (req) => ({
  id:         req.user.id,
  context_id: req.params.branchId,
}))

// Cashier module
const cashierRbac = cashierApp.rbac.forPortal('cashier', (req) => ({
  id:         req.user.id,
  context_id: req.params.terminalId,
}))
```

---

**Next:** [is_super](./is-super)
