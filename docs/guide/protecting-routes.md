# Protecting Routes

`requirePolicy` is a Fastify `preHandler` that checks whether the current user has a given policy. If they don't, the request is rejected before your handler runs.

---

## Basic usage

```ts
app.get('/transactions', {
  preHandler: rbac.requirePolicy('transaction.view'),
}, handler)

app.post('/transactions', {
  preHandler: rbac.requirePolicy('transaction.create'),
}, handler)

app.delete('/transactions/:id', {
  preHandler: rbac.requirePolicy('transaction.void'),
}, handler)
```

`rbac` is the instance returned by `app.rbac.forPortal(...)`. See [Identifying the Current User](./subject).

---

## Routes with scopes

If a policy might be assigned with a scope, provide a `resource` resolver. The library calls it when the user's assignment has a scope, and passes the result to the scope check function:

```ts
app.post('/transactions/:id/void', {
  preHandler: rbac.requirePolicy('transaction.void', {
    resource: (req) => ({ type: 'transaction', id: req.params.id }),
  }),
}, handler)
```

When the user's assignment is `null` (unrestricted), the resolver is never called — the request passes immediately.

---

## What happens on each request

1. The `forPortal` callback runs and resolves the subject. If there is no `id`, the request is rejected with **401 Unauthorized**.
2. If `is_super` is `true` — passes immediately. No cache or database lookup.
3. The user's policy map is loaded from cache or the database.
4. If the policy is not in the map — **403 Forbidden**.
5. If the policy has a scope in the map:
   - No resource resolver provided → **403 Forbidden**
   - Resource resolver returns `null` → **404 Not Found**
   - Scope check returns `false` → **403 Forbidden**
   - Scope check returns `true` → passes

---

## Response reference

| Situation | Status |
|-----------|--------|
| No authenticated user | 401 Unauthorized |
| Policy not in the user's map | 403 Forbidden |
| Scope check returns false | 403 Forbidden |
| Scope needed but no resource resolver | 403 Forbidden |
| Resource resolver returns null | 404 Not Found |
| `is_super: true` | Handler runs |

---

**Next:** [Assigning Users](./assigning-users)
