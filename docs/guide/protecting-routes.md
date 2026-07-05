# Protecting routes

`requirePolicy` guards a route:

::: code-group

```ts [Fastify]
app.get(
  '/sales',
  { preHandler: staff.requirePolicy('sales.view') },
  listSales,
)

app.post(
  '/sales',
  { preHandler: staff.requirePolicy('sales.create') },
  createSale,
)
```

```ts [Express]
app.get('/sales', staff.requirePolicy('sales.view'), listSales)
app.post('/sales', staff.requirePolicy('sales.create'), createSale)
```

:::

The user must hold the named policy. Otherwise the request is denied. Viewing sales and ringing them up are separate policies.

`staff` here is a domain with no name — the single-app form. Policies stay unprefixed. Named domains add their prefix. See [Multi-tenancy](/guide/multi-tenancy).

## getSubject

Return the logged-in staff member, or `null`:

```ts
const staff = app.rbac.domain({
  getSubject: async req => {
    const token = req.headers.authorization?.slice('Bearer '.length)
    if (!token) return null
    const payload = await verifyJwt(token)
    return payload ? { id: payload.sub, tenant_id: payload.storeId } : null
  },
})
```

`getSubject` runs once per request, when the first guard fires. Return `null` and the guard responds 401. The `id` is any string that identifies the user. `tenant_id` is optional and marks the store. See [Multi-tenancy](/guide/multi-tenancy).

## The four outcomes

Every guarded request ends one of four ways:

| Status | Meaning | `code` in the body |
| --- | --- | --- |
| 200 | Allowed | — |
| 401 | No logged-in user | `RBAC_UNAUTHENTICATED` |
| 403 | Policy not granted, or scope check failed | `RBAC_POLICY_DENIED` / `RBAC_SCOPE_DENIED` |
| 404 | Scoped grant, but the resource does not exist | `RBAC_RESOURCE_NOT_FOUND` |

The exact response bodies are shown in [Fastify](/guide/fastify) and [Express](/guide/express).

## Scoped grants need a resource resolver

A grant is one policy given to one user. A grant can carry a scope. A cashier holds `sales.void` scoped to `owned`. A manager holds it unscoped. A cashier can void their own sale. A manager can void any sale. The guard then needs to know which sale the request targets:

::: code-group

```ts [Fastify]
app.post('/sales/:id/void', {
  preHandler: staff.requirePolicy('sales.void', {
    resource: req => ({ type: 'sale', id: (req.params as { id: string }).id }),
  }),
}, voidSale)
```

```ts [Express]
app.post(
  '/sales/:id/void',
  staff.requirePolicy('sales.void', {
    resource: req => ({ type: 'sale', id: req.params.id }),
  }),
  voidSale,
)
```

:::

The resolver returns the target's `type` and `id`. Return `null` when the sale does not exist. The guard then responds 404.

The manager's unscoped grant skips the check. The cashier's scoped grant is denied if the route has no resolver. So add a resolver to every route where a scoped grant can land. See [Scopes](/guide/scopes) and [Assigning access](/guide/assigning-access).
