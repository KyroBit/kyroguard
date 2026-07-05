# What is @kyrobit/rbac

@kyrobit/rbac decides, on every request, whether the authenticated user may run the route they are calling. You define policies in TypeScript, sync them to your database with one command, and attach guards to Fastify or Express routes; this page walks you through the six concepts the whole library is built on and what happens during a single guarded request.

## The six concepts

### Policy

A policy is a named permission, such as `posts.update`. Routes require policies; users hold them (directly or through groups). A policy can declare dependencies — policies that anyone holding it also needs — and scope options that narrow it to specific rows.

```ts
import { Policy, Scope } from '@kyrobit/rbac'

new Policy('posts.update', 'Update posts', ['posts.read'], [Scope.owned()])
```

### Group

A group bundles policies under one name so you assign a role, not twenty individual grants. Each entry maps a policy to a scope: `null` means unrestricted, a scope name (such as `'owned'`) restricts the policy to rows that pass that scope's check.

```ts
import type { GroupsDefinition } from '@kyrobit/rbac'

export const groups: GroupsDefinition = {
  editor: {
    label: 'Editor',
    policies: { 'posts.read': null, 'posts.update': 'owned' },
  },
}
```

### Subject

The subject is the authenticated principal — you resolve it from your session or JWT and return it from `getSubject`. It needs an `id`; `context_id` places it in a tenant, and `is_super` marks a break-glass account that bypasses policy checks. Returning `null` means the request is unauthenticated and the guard responds 401.

```ts
getSubject: async request => {
  const user = await verifySession(request)
  return user ? { id: user.id, context_id: user.tenantId } : null
}
```

### Portal

A portal is one surface of your application — an admin panel, a customer dashboard, a partner API — each with its own policy namespace. The portal qualifies every policy name (`posts.read` on portal `admin` is stored as `admin.posts.read`), so the same route shape can carry different permissions per surface.

```ts
const portal = app.rbac.portal('admin', { getSubject })
portal.requirePolicy('posts.read') // checks admin.posts.read
```

### Tenant context

The tenant context (`context_id`) is the second isolation axis: a grant recorded for context `branch_1` applies only to requests whose subject carries `context_id: 'branch_1'`. Portal and context are matched by strict equality — a grant with no context never applies to a request with one, and vice versa; this is what keeps tenant data isolated. Internally "no context" is stored as the empty string `''`, never `NULL`, so equality and unique constraints behave identically on PostgreSQL, MySQL, SQLite and MongoDB.

```ts
await rbac.admin.assignGroup(
  { subjectId: 'u_1', portal: 'branch', contextId: 'branch_1' },
  'manager',
)
```

### Scope

A scope is a named row-level check attached to a grant. When a grant carries a scope, holding the policy is not enough: the guard resolves the target resource and the scope's check function decides whether this subject may touch this row. `Scope.owned()` is built in and asks the adapter's ownership store, so it behaves the same on every backend.

```ts
import { Scope } from '@kyrobit/rbac'

const owned = Scope.owned() // passes when the subject owns the resource
const sameTenant = new Scope('same-tenant', 'Same tenant', async (subject, resource, ctx) => {
  return subject.context_id === (await loadTenantOf(resource, ctx.db))
})
```

## What happens on a guarded request

Every guard runs the same decision procedure. It either resolves — the handler runs — or throws a typed `RbacError`, which travels through the framework's own error pipeline (Fastify: thrown into the error handler; Express: `next(err)` into `errorHandler()`), so your CORS headers, hooks and custom error handling keep working.

```
request
   │
   ▼
guard: portal.requirePolicy('posts.update', { resource })
   │
   ├─ 1. resolve subject       getSubject(request), memoized per request per portal
   │      no subject ────────► UnauthenticatedError    401  RBAC_UNAUTHENTICATED
   │      is_super ──────────► allow (skip all checks)
   │
   ├─ 2. policy lookup         policy map from the cache, or the storage
   │                           adapter on a miss (strict portal + context match)
   │      not granted ───────► PolicyDeniedError       403  RBAC_POLICY_DENIED
   │      granted, no scope ─► allow
   │
   ├─ 3. scope check           only when the grant names a scope
   │      resource is null ──► ResourceNotFoundError   404  RBAC_RESOURCE_NOT_FOUND
   │      check fails ───────► ScopeDeniedError        403  RBAC_SCOPE_DENIED
   │      check passes ──────► allow
   │
   ▼
route handler runs
```

A denied request gets a JSON body with a stable machine-readable code. Through Express's `errorHandler()` the body is exactly the error's own shape:

```json
{ "message": "Forbidden", "code": "RBAC_POLICY_DENIED" }
```

Fastify's default error serializer adds its usual fields around the same code:

```json
{
  "statusCode": 403,
  "code": "RBAC_POLICY_DENIED",
  "error": "Forbidden",
  "message": "Forbidden"
}
```

All five codes are documented in the [error reference](/reference/errors).

::: warning Scoped grants fail closed
When a grant carries a scope but the route passes no `resource` resolver — or the scope name is not registered in your resource definitions — the guard denies with `RBAC_SCOPE_DENIED`. A missing resolver is never treated as "no restriction", because that would silently widen a deliberately narrowed grant.
:::

## When to use it

Use @kyrobit/rbac when your API has named roles or permissions that admins assign to users, especially when the same codebase serves several surfaces (portals) or several tenants (contexts), and you want the policy catalog versioned in code rather than hand-edited in a database.

Skip it when it does not fit:

- **Single-user apps.** If every authenticated user may do everything, an authentication check is all you need — a policy layer only adds tables and lookups.
- **Pure ABAC needs.** If most decisions derive from arbitrary attribute combinations ("managers may approve expenses under 500 filed by their own reports on weekdays") rather than from possession of a named grant, a rules engine fits better. Scopes give you a bounded per-row escape hatch, but possession of a policy is always the first gate.

## Next steps

- [Installation](/guide/installation) — set up the package, your database and your framework end to end.
- [Quick start](/guide/quick-start) — a ten-minute tutorial with no database.
- [Protecting routes](/guide/protecting-routes) — guard patterns beyond a single policy.
