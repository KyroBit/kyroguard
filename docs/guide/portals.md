# Portals and tenants

Portals split one app into named areas, like `admin` and `customer`. Contexts split access by tenant. Both match exactly, and that is what keeps access contained.

## Portals

One shop app, two portals:

```ts
const admin = app.rbac.portal('admin', {
  getSubject: req => getStaffSession(req),
})

const customer = app.rbac.portal('customer', {
  getSubject: req => getCustomerSession(req),
})

app.get('/admin/orders',
  { preHandler: admin.requirePolicy('orders.read') },
  listAllOrders)

app.get('/my/orders',
  { preHandler: customer.requirePolicy('orders.read') },
  listMyOrders)
```

Staff sign in through `admin`. Shoppers sign in through `customer`. Each portal resolves its own user, even on the same app.

A grant on one portal never works on another. Give someone `orders.read` on `customer`, and the admin routes still reject them.

Each portal also has its own policy names. `admin.requirePolicy('orders.read')` checks `admin.orders.read`. The `customer` guard checks `customer.orders.read`. They are different policies. Define each portal's policies in your resources. See [Policies](/guide/policies).

Most apps start with a single portal. Add a second one when a second kind of user shows up.

## Contexts

A context splits grants by tenant. Make someone a manager in branch-1, and that is the only place they are a manager:

```ts
await branch.assignGroup(user.id, 'manager', { contextId: 'branch-1' })
```

Grants are exact. A grant in branch-1 never applies in branch-2, and a grant without a context never applies inside one.

On the request side, put the tenant on the user in `getSubject`:

```ts
const branch = app.rbac.portal('branch', {
  getSubject: async req => {
    const user = await getUser(req)
    return user ? { id: user.id, context_id: user.branchId } : null
  },
})
```

`context_id` tells the guard which tenant the request belongs to. The guard only counts grants made for that tenant.

## Both together

```ts
app.get('/reports',
  { preHandler: branch.requirePolicy('reports.read') },
  listReports)
```

The manager from above requests `/reports` with `context_id: 'branch-1'`. Allowed. The same user with `context_id: 'branch-2'` gets a 403. Nothing about the route changed. Only the tenant did.

One thing to watch: omitting `contextId` when assigning does not make a grant global. It makes a grant for requests that carry no tenant. To make someone a manager in three branches, assign three times. Assignment details are in [Assigning access](/guide/assigning-access).
