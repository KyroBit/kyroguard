# Fastify

Reference for `@kyrobit/rbac/fastify`. Requires Fastify 5.x. For a walkthrough, see [Fastify](/guide/fastify).

## rbacFastify()

```ts
import { rbacFastify } from '@kyrobit/rbac/fastify'

function rbacFastify(rbac: Rbac, options?: RbacFastifyOptions): FastifyPluginAsync
```

| Parameter | Type | Description |
| --- | --- | --- |
| `rbac` | `Rbac` | The instance from [`createRbac()`](/reference/core-api#createrbac). |
| `options.formatError` | `(error: RbacError, req: FastifyRequest) => { status: number; body: unknown }` | Optional. Custom response body for denials. |

The plugin opens the request context on every request and decorates the app with `app.rbac`. Register it once. It is visible to the whole app, not only the registration scope.

```ts
import Fastify from 'fastify'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { rbac } from './rbac.js'

const app = Fastify()
await app.register(rbacFastify(rbac))

const staff = app.rbac.domain({
  getSubject: async req => {
    const user = await verifySession(req.headers.authorization)
    return user ? { id: user.id, tenant_id: user.branchId } : null
  },
})

app.get('/sales', { preHandler: staff.requirePolicy('sales.view') }, async () => {
  return { ok: true }
})
```

## app.rbac

| Member | Description |
| --- | --- |
| `domain(name, options)` | Create a named [domain instance](#domain-instance) — one per app area, like `admin` and `branch`. |
| `domain(options)` | Domain-less overload for single-area apps. Policy names stay unprefixed. |
| `setSubject(subject)` | Set the active user directly (custom auth outside a domain). |
| `addExtra(extra)` | Override the next tracked insert's ownership row. Applies once. See [ownership](/reference/core-api#rbac). |
| `cache` | Cache control: `invalidateSubject(subjectId)`, `clear()`. |

## Domain instance

```ts
const staff = app.rbac.domain({ getSubject })          // single-area app
const admin = app.rbac.domain('admin', { getSubject }) // multi-area app
```

`options.getSubject(req)` returns the logged-in user, or `null` for a 401. It runs once per request per domain.

| Method | Description |
| --- | --- |
| `name` | The domain name. `''` for the domain-less overload. |
| `requirePolicy(policy, options?)` | Returns a guard for `preHandler` or `onRequest`. Takes the unqualified name (`sales.view`, not `branch.sales.view`). `options.resource(req)` resolves the target row; required for scoped grants. On allow, reads of the policy's resource are filtered by this grant for the rest of the request ([automatic filtering](/guide/scopes#automatic-filtering)). |
| `filterFor(req, policy)` | The policy's list decision as a [`FilterResult`](/reference/core-api#filterfor), for queries you build yourself. |
| `subjectHook()` | Resolves the user without guarding. For unguarded routes that still record ownership. It activates no read filter. Register per scope, never app-wide. |
| `assignGroup(subjectId, group, options?)` | Assign a group in this domain. `options.tenantId` targets one store, like `branch-1`. |
| `removeGroup(subjectId, group, options?)` | Remove a group. |
| `assignPolicy(subjectId, policy, options?)` | Grant one policy. Unqualified name. `options`: `tenantId`, `scope`. |
| `removePolicy(subjectId, policy, options?)` | Remove a direct grant. |

**Throws** `MisconfiguredError` (500) from any guard when `rbacFastify()` was not registered.

## Error responses

A denied guard throws the `RbacError` through Fastify's own error pipeline. Your `setErrorHandler`, `onSend` hooks and CORS headers keep running. The default serializer produces:

```json
// 403 — policy not granted
{ "statusCode": 403, "code": "RBAC_POLICY_DENIED", "error": "Forbidden", "message": "Forbidden" }

// 401 — getSubject returned null
{ "statusCode": 401, "code": "RBAC_UNAUTHENTICATED", "error": "Unauthorized", "message": "Unauthorized" }
```

Scoped denials produce `RBAC_SCOPE_DENIED` (403) and `RBAC_RESOURCE_NOT_FOUND` (404) the same way. See [Errors](/reference/errors).

### formatError

Pass `formatError` to shape the denial response yourself:

```ts
await app.register(
  rbacFastify(rbac, {
    formatError: (error, req) => ({
      status: error.statusCode,
      body: { code: error.code, path: req.url },
    }),
  }),
)
```

`onSend` hooks and CORS headers still run on formatted responses.

::: warning
`formatError` only sees `RbacError` denials. An error thrown by your own `getSubject` goes to Fastify's error handler unchanged. Handle it there.
:::
