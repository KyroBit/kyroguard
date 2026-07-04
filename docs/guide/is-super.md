# is_super

When `is_super` is `true` on the subject, the user bypasses every `requirePolicy` check. No policy lookup, no scope evaluation — the route handler runs immediately.

The library doesn't define what "super" means. Return `is_super: true` from the `forPortal` callback whenever your condition is met.

---

## Simple app

```ts
const rbac = app.rbac.forPortal('admin', async (req) => ({
  id:       req.user.id,
  is_super: req.user.isSuperAdmin,
}))
```

---

## Multi-portal — different logic per portal

Each portal can have its own definition of what qualifies as super:

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

// Cashier — no super access
const cashierRbac = cashierApp.rbac.forPortal('cashier', (req) => ({
  id:         req.user.id,
  context_id: req.params.terminalId,
}))
```

---

## What is_super bypasses

When `is_super` is `true`, `requirePolicy` skips:

- The policy cache lookup
- The database query for group and policy assignments
- All scope check functions

The handler always runs, regardless of which policies the user has (or doesn't have).

---

**Next:** [Cache](./cache)
