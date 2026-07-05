# Multi-tenancy

Domains split one backend into named apps, like `admin` and `branch`. Tenants split access by store — `branch-1`, `branch-2`. Both match exactly, and that is what keeps access contained.

## Domains

One hardware-store chain, two staff apps. `admin` is the head-office app. `branch` is the in-store app:

```ts
const admin = app.rbac.domain('admin', {
  getSubject: req => getHeadOfficeSession(req),
})

const branch = app.rbac.domain('branch', {
  getSubject: req => getStoreSession(req),
})

app.get('/reports',
  { preHandler: admin.requirePolicy('reports.view') },
  listReports)

app.get('/sales',
  { preHandler: branch.requirePolicy('sales.view') },
  listSales)
```

Head-office staff sign in through `admin`. Store staff sign in through `branch`. Each domain resolves its own user, even on the same app.

A grant on one domain never works on another. Give someone `sales.view` on `branch`, and the head-office routes still reject them.

Each domain also has its own policy names. `admin.requirePolicy('reports.view')` checks `admin.reports.view`. The `branch` guard checks `branch.sales.view`. They are different policies. Each domain gets its own policies file: `reports.view` and `staff.manage` for head office, the sales and product policies for stores. See [Policies](/guide/policies).

A single-app setup skips domains entirely. `app.rbac.domain({ getSubject })` takes no name, and policies stay unprefixed. Add domains when a second app shows up.

## Tenants

Each store is a tenant: `branch-1`, `branch-2`. Make Amina a manager in branch-1, and that is the only store where she is one:

```ts
await branch.assignGroup(amina.id, 'manager', { tenantId: 'branch-1' })
```

Grants are exact. Amina is a manager in branch-1. In branch-2 she has no access at all.

On the request side, put the store on the user in `getSubject`:

```ts
const branch = app.rbac.domain('branch', {
  getSubject: async req => {
    const user = await getStoreSession(req)
    return user ? { id: user.id, tenant_id: user.storeId } : null
  },
})
```

`tenant_id` tells the guard which store the request belongs to. The guard only counts grants made for that store.

## Both together

```ts
app.get('/sales',
  { preHandler: branch.requirePolicy('sales.view') },
  listSales)
```

Amina requests `/sales` with `tenant_id: 'branch-1'`. Allowed. The same request from branch-2 gets a 403. Nothing about the route changed. Only the store did.

A store can also have an owner — one user who passes every check in that store. See [Owners](/guide/assigning-access#owners).

One thing to watch: omitting `tenantId` when assigning does not make a grant global. It makes a grant for requests that carry no store. To make Amina a manager in three stores, assign three times. Assignment details are in [Assigning access](/guide/assigning-access).
