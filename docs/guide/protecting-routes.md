# Protecting routes

`requirePolicy` guards a route:

::: code-group

```ts [Fastify]
app.get(
  '/posts',
  { preHandler: admin.requirePolicy('posts.read') },
  listPosts,
)
```

```ts [Express]
app.get('/posts', admin.requirePolicy('posts.read'), listPosts)
```

:::

The user must hold `posts.read` on the `admin` portal. Otherwise the request is denied.

Policy names stay short. The portal adds its own prefix, so `admin.requirePolicy('posts.read')` checks `admin.posts.read`.

## getSubject

Return the logged-in user, or `null`:

```ts
const admin = app.rbac.portal('admin', {
  getSubject: async req => {
    const token = req.headers.authorization?.slice('Bearer '.length)
    if (!token) return null
    const payload = await verifyJwt(token)
    return payload ? { id: payload.sub, context_id: payload.orgId } : null
  },
})
```

`getSubject` runs once per request, when the first guard fires. Return `null` and the guard responds 401. The `id` is any string that identifies the user. `context_id` is optional and marks the tenant. See [Portals and tenants](/guide/portals).

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

A grant is one policy given to one user. A grant can carry a scope. Example: `posts.edit` scoped to `owned` lets a user edit only their own posts. The guard then needs to know which post the request targets:

::: code-group

```ts [Fastify]
app.patch('/posts/:id', {
  preHandler: admin.requirePolicy('posts.edit', {
    resource: req => ({ type: 'post', id: (req.params as { id: string }).id }),
  }),
}, updatePost)
```

```ts [Express]
app.patch(
  '/posts/:id',
  admin.requirePolicy('posts.edit', {
    resource: req => ({ type: 'post', id: req.params.id }),
  }),
  updatePost,
)
```

:::

The resolver returns the target's `type` and `id`. Return `null` when the row does not exist. The guard then responds 404.

Users with an unscoped grant skip the check. Users with a scoped grant are denied if the route has no resolver. So add a resolver to every route where a scoped grant can land. See [Scopes](/guide/scopes) and [Assigning access](/guide/assigning-access).
