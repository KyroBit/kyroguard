# Configuration

`rbac.config.ts` lives at your project root. The `rbac sync` CLI reads it to know which policies and groups to push to the database and which types to generate.

---

## Single portal

For most apps, one portal is all you need:

```ts
// rbac.config.ts
export default {
  policies: './src/rbac/policies.ts',
  groups:   './src/rbac/groups.ts',
}
```

`policies` points to the file that exports `resources: ResourceDefinition[]`. `groups` points to the file that exports `groups`.

---

## Multiple portals

When your app has distinct sections with different permission sets — for example an admin back-office, a branch portal, and a cashier terminal — use an array. Each entry defines one portal:

```ts
// rbac.config.ts
export default [
  {
    name:     'admin',
    policies: './src/rbac/admin/policies.ts',
    groups:   './src/rbac/admin/groups.ts',
  },
  {
    name:     'branch',
    policies: './src/rbac/branch/policies.ts',
    groups:   './src/rbac/branch/groups.ts',
  },
  {
    name:     'cashier',
    policies: './src/rbac/cashier/policies.ts',
    groups:   './src/rbac/cashier/groups.ts',
  },
]
```

The `name` field is the portal identifier used in `forPortal` and stored in the database. Portals are completely isolated — policies from one portal never affect another.

`policies: 'all'` in a groups file assigns every policy from **that portal only**. An `all` group in the branch portal never picks up admin or cashier policies.

---

## Generated types

After `rbac sync`, a `rbac.d.ts` file is created at the project root:

```ts
// rbac.d.ts  (auto-generated — do not edit)
declare module '@kyrobit/rbac' {
  type Portal = 'admin' | 'branch' | 'cashier'

  type PolicyName =
    | 'transaction.view'
    | 'transaction.create'
    | 'transaction.void'
    | 'dashboard.view'
    // ...all policies across all portals

  type PortalPolicies = {
    admin:   'dashboard.view' | 'user.invite' | ...
    branch:  'transaction.view' | 'transaction.create' | ...
    cashier: 'transaction.view' | 'sale.process' | ...
  }
}
```

With these types in place:

- `forPortal('branchh')` is a **TypeScript error** — not a valid portal name
- `requirePolicy('transacton.view')` is a **TypeScript error** — typo caught at compile time
- Each `PortalInstance` only accepts policy names that belong to its portal

---

## Keep rbac.d.ts out of version control

The file is generated from your database state at sync time. Commit your config and source files; let each developer and CI run generate their own copy:

```
# .gitignore
rbac.d.ts
```

---

**Next:** [Plugin Setup](./plugin)
