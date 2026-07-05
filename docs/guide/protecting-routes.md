# Protecting routes

You attach `requirePolicy` guards to routes on Fastify and Express, grant the policies they check, and read the exact decision table every guard walks — including all four denied responses and their `RBAC_*` codes.

::: tip Prerequisites
You need a portal with working subject resolution — see [Setting up Fastify](/guide/setting-up-fastify) or [Setting up Express](/guide/setting-up-express), and [Resolving the subject](/guide/resolving-the-subject). Examples use the starter `post` resource and an `admin` portal.
:::

## 1. Attach a guard

::: code-group

```ts [Fastify]
app.get(
  '/posts/:id',
  { preHandler: admin.requirePolicy('posts.read') },
  async request => ({ id: (request.params as { id: string }).id }),
)
```

```ts [Express]
app.get('/posts/:id', admin.requirePolicy('posts.read'), (req, res) => {
  res.json({ id: req.params.id })
})
```

:::

Policy names are unqualified — the portal prefixes them. `requirePolicy('posts.read')` on the `admin` portal checks the stored grant `admin.posts.read`; in a portal-less setup (portal name `''`) names are stored and checked unprefixed. Grants are stored fully qualified and matched — together with `portal` and `context_id` — by strict equality, so a grant issued in the `customer` portal can never satisfy an `admin` route, and a grant issued for `context_id: 'branch-1'` never applies to a request in another context or in none. Qualification happens in exactly one place (the engine), so stored names and checked names cannot drift apart.

After you run `rbac generate`, `requirePolicy` autocompletes the policy names that exist for this portal.

## 2. Grant the policy

Portal assignment methods take the same unqualified names and qualify them for you:

```ts
await admin.assignPolicy('user-1', 'posts.read')
await admin.assignPolicy('user-1', 'posts.update', { scope: 'owned' })
await admin.assignPolicy('user-1', 'posts.read', { contextId: 'branch-1' })
await admin.assignGroup('user-2', 'editors')
```

Assignments are idempotent upserts, and every mutation invalidates that subject's cached policy map and publishes the invalidation on the bus (cross-instance when you configure a distributed one) — a revoked grant stops working without waiting for a cache TTL.

## 3. Resolve the resource for scoped grants

A grant can carry a scope — a named row-level check such as `owned`. When the resolved grant is scoped, the guard needs to know which row the request targets, so pass a resource resolver:

::: code-group

```ts [Fastify]
app.patch(
  '/posts/:id',
  {
    preHandler: admin.requirePolicy('posts.update', {
      resource: request => ({ type: 'post', id: (request.params as { id: string }).id }),
    }),
  },
  async request => {
    // update the post
  },
)
```

```ts [Express]
app.patch(
  '/posts/:id',
  admin.requirePolicy('posts.update', {
    resource: req => ({ type: 'post', id: req.params.id }),
  }),
  (req, res) => {
    res.json({ updated: req.params.id })
  },
)
```

:::

The resolver returns a `{ type, id }` reference (or `null` when the target does not exist); the scope's check function then decides for that row — for `Scope.owned()`, whether the subject is recorded as the row's owner. When the grant is unrestricted (no scope), the resolver is never called. When a subject holds duplicate grants of one policy — say an unrestricted one from a group and a scoped direct one — the unrestricted grant wins.

::: warning Missing scope wiring is a deny, never a bypass
If the resolved grant is scoped but the route has no `resource` resolver — or the scope name is not registered in any policy's `scopeOptions` — every request is denied with `403 RBAC_SCOPE_DENIED`, including requests from the row's owner. The engine refuses to guess: silently treating a scoped grant as unrestricted would widen access on a wiring mistake.
:::

## The decision table

Every guard walks this sequence, in order:

| # | Condition | Result |
| --- | --- | --- |
| 1 | `getSubject` returned `null`, or the subject's `id` is empty | **401** `RBAC_UNAUTHENTICATED` |
| 2 | `subject.is_super === true` (and super bypass is enabled) | allow |
| 3 | Policy not granted for this subject + portal + context | **403** `RBAC_POLICY_DENIED` |
| 4 | Grant is unrestricted (no scope) | allow |
| 5 | Grant is scoped, but the scope is not registered or the route has no resource resolver | **403** `RBAC_SCOPE_DENIED` |
| 6 | Resource resolver returned `null`/`undefined` | **404** `RBAC_RESOURCE_NOT_FOUND` |
| 7 | Scope check returned `false` | **403** `RBAC_SCOPE_DENIED` |
| 8 | Scope check returned `true` | allow |

The denied bodies, exactly as Express's `errorHandler()` sends them:

::: code-group

```json [401]
{ "message": "Unauthorized", "code": "RBAC_UNAUTHENTICATED" }
```

```json [403 policy]
{ "message": "Forbidden", "code": "RBAC_POLICY_DENIED" }
```

```json [403 scope]
{ "message": "Forbidden", "code": "RBAC_SCOPE_DENIED" }
```

```json [404]
{ "message": "Not found", "code": "RBAC_RESOURCE_NOT_FOUND" }
```

:::

Fastify's default error serializer wraps the same `code` and `message` with two extra fields:

```json
{
  "statusCode": 403,
  "code": "RBAC_POLICY_DENIED",
  "error": "Forbidden",
  "message": "Forbidden"
}
```

Clients should branch on `code`, not on status or message — the two 403s mean different things (`RBAC_POLICY_DENIED`: the subject lacks the policy entirely; `RBAC_SCOPE_DENIED`: the policy is granted but not for this row).

Why an unresolved resource is 404 rather than 403: when your resolver looks the row up and finds nothing, the target genuinely does not exist for this request, and the response matches what any read of that id would return. The scope check never runs on a row that could not be resolved.

## Stacking guards

Both integrations accept several guards on one route. The subject is resolved once per request per portal, however many of its guards run:

::: code-group

```ts [Fastify]
app.post(
  '/posts/:id/publish',
  {
    preHandler: [
      admin.requirePolicy('posts.read'),
      admin.requirePolicy('posts.update', {
        resource: request => ({ type: 'post', id: (request.params as { id: string }).id }),
      }),
    ],
  },
  async () => ({ published: true }),
)
```

```ts [Express]
app.post(
  '/posts/:id/publish',
  admin.requirePolicy('posts.read'),
  admin.requirePolicy('posts.update', {
    resource: req => ({ type: 'post', id: req.params.id }),
  }),
  (req, res) => {
    res.json({ published: true })
  },
)
```

:::

## Next steps

- [Scopes](/guide/writing-scopes) — write custom row-level checks beyond `Scope.owned()`.
- [Resolving the subject](/guide/resolving-the-subject) — where `context_id`, `is_super` and scope-check fields come from.
- [Error reference](/reference/errors) — every `RBAC_*` code in one place.
