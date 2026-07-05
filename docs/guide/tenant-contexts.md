# Tenant contexts

A context scopes a user's grants to one tenant — a branch, a workspace, an organization — inside a portal. On this page you give the same user different roles in two branches and confirm that neither role leaks into the other branch, or into requests with no branch at all.

::: tip Prerequisites
This page builds on the two-portal setup from [Portals](/guide/portals). You need the `branch` portal with its `orders.read` / `orders.refund` policies synced.
:::

## 1. Put `context_id` on the subject

The subject your `getSubject` returns carries the tenant in `context_id`. Resolve it from wherever your app expresses "which tenant is this request for" — a header, a subdomain, a route prefix, a JWT claim:

::: code-group

```ts [Fastify]
const branch = app.rbac.portal('branch', {
  getSubject: async request => {
    const user = await resolveUserToken(request) // your auth
    if (!user) return null
    return {
      id: user.id,
      context_id: request.headers['x-branch-id'] as string | undefined,
    }
  },
})
```

```ts [Express]
const branch = guards.portal('branch', {
  getSubject: async req => {
    const user = await resolveUserToken(req) // your auth
    if (!user) return null
    return {
      id: user.id,
      context_id: req.header('x-branch-id'),
    }
  },
})
```

:::

Letting the client pick the context is safe for authorization: a context value only unlocks grants that were explicitly assigned in that exact context. Presenting `x-branch-id: branch-2` gives a user nothing unless someone granted them a role in `branch-2`. (Your data queries still need their own tenant filtering — the guard authorizes the action, it does not rewrite your SQL.)

## 2. Seed the roles

```ts
// src/rbac/branch/groups.ts
import type { GroupsDefinition } from '@kyrobit/rbac'

export const groups: GroupsDefinition = {
  cashier: {
    label: 'Cashier',
    policies: ['orders.read'],
  },
  manager: {
    label: 'Branch manager',
    policies: ['orders.read', 'orders.refund'],
  },
}
```

```bash
npx rbac sync
```

## 3. Assign the same user different roles per context

```ts
// anywhere with access to the `branch` portal instance —
// standalone scripts use rbac.admin instead (see Assigning access)
await branch.assignGroup('user-42', 'cashier', { contextId: 'branch-1' })
await branch.assignGroup('user-42', 'manager', { contextId: 'branch-2' })
```

Both rows belong to `user-42` in the `branch` portal, but each is pinned to one context. The full coordinates of a grant are `(subject, portal, contextId)`.

## 4. Watch the same route answer differently per context

With the routes from the portals page in place:

```ts
app.get(
  '/branch/orders',
  { preHandler: branch.requirePolicy('orders.read') },
  async () => listOrders(),
)

app.post(
  '/branch/orders/:id/refund',
  { preHandler: branch.requirePolicy('orders.refund') },
  async request => refundOrder((request.params as { id: string }).id),
)
```

`user-42` now sees:

| Request | Result |
| --- | --- |
| `GET /branch/orders` with `x-branch-id: branch-1` | `200` — cashier in `branch-1` |
| `POST /branch/orders/o1/refund` with `x-branch-id: branch-1` | `403` — cashiers cannot refund |
| `POST /branch/orders/o1/refund` with `x-branch-id: branch-2` | `200` — manager in `branch-2` |
| `GET /branch/orders` with `x-branch-id: branch-3` | `403` — no grants in `branch-3` |
| `GET /branch/orders` with no `x-branch-id` header | `403` — no context-less grants exist |

Every denied request gets `403` with:

```json
{
  "message": "Forbidden",
  "code": "RBAC_POLICY_DENIED"
}
```

## Strict matching, in both directions

A grant applies to a request only when portal **and** context match by plain equality:

| Grant stored at | Request at | Applies |
| --- | --- | --- |
| `('branch', 'branch-1')` | `('branch', 'branch-1')` | yes |
| `('branch', 'branch-1')` | `('branch', 'branch-2')` | no |
| `('branch', 'branch-1')` | `('branch', '')` — no context | no |
| `('branch', '')` — no context | `('branch', 'branch-1')` | no |

::: danger No fallback is the contract
An earlier generation of this library fell back to a subject's context-less grants when the request carried a context — and its cache derived keys by joining the non-empty parts of `(subject, portal, context)`, so two different security contexts could even collide on one cache entry. Both behaviors belong to the same bug class: a grant made for "nowhere in particular" silently applying everywhere, which in a multi-tenant system means one tenant's operator acting inside another tenant.

The v1 storage contract (clause S2) forbids fallback in either direction: a grant at `('', '')` is returned only for a request at `('', '')`, and a grant at `('branch', 'branch-1')` only for `('branch', 'branch-1')`. Portal and context are matched by strict equality — a grant with no context never applies to a request with one, and a context-scoped grant never applies to a context-less request. This is what keeps tenant data isolated, and the adapter contract test suite enforces it on every storage backend.
:::

::: warning A grant that never matches
The strictness cuts both ways. If you assign roles with `contextId` but your `getSubject` forgets to set `context_id` (or the reverse), every request is denied with `RBAC_POLICY_DENIED` even though the grants exist — they sit at coordinates no request ever presents. When a user "has the role but gets 403", compare the stored `(portal, contextId)` of the grant with what `getSubject` returns.
:::

## The `''` sentinel

Internally, "no portal" and "no context" are stored as the empty string, never as `NULL`. `toSubjectRef` normalizes `context_id: undefined` to `''`, and every adapter stores the portal and context as non-null strings (the SQL schemas declare the columns `NOT NULL DEFAULT ''`; the Mongoose models store `''` the same way).

The reason is behavioral, not cosmetic: SQL unique indexes treat `NULL`s as distinct from each other, so nullable portal/context columns would let the same assignment be inserted twice and would make "match no context" require `IS NULL` special-casing that differs across PostgreSQL, MySQL, SQLite and MongoDB. With `''`, strict matching is plain equality on every backend, the unique constraint that makes assignments idempotent works identically everywhere, and a null-context fallback is structurally impossible — there is no `NULL` to fall back to.

You never write `''` yourself; omitting `context_id` on the subject or `contextId` on an assignment means "none" and both sides normalize to the same sentinel.

## Next steps

- [Assigning access](/guide/assigning-access) — grant and revoke per-context roles from admin panels and scripts
- [Writing scopes](/guide/writing-scopes) — row-level checks such as "only orders in the user's branch"
- [Portals](/guide/portals) — how the portal half of the coordinate pair works
