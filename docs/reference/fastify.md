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

const admin = app.rbac.portal('admin', {
  getSubject: async req => {
    const user = await verifySession(req.headers.authorization)
    return user ? { id: user.id, context_id: user.branchId } : null
  },
})

app.get('/posts', { preHandler: admin.requirePolicy('posts.read') }, async () => {
  return { ok: true }
})
```

## app.rbac

| Member | Description |
| --- | --- |
| `portal(name, options)` | Create a [portal instance](#portal-instance). `options.getSubject(req)` returns the logged-in user, or `null` for a 401. It runs once per request per portal. |
| `setSubject(subject)` | Set the active user directly (custom auth outside a portal). |
| `addExtra(extra)` | Override the next tracked insert's ownership row. Applies once. See [ownership](/reference/core-api#rbac). |
| `cache` | Cache control: `invalidateSubject(subjectId)`, `clear()`. |

## Portal instance

```ts
const admin = app.rbac.portal('admin', { getSubject })
```

| Method | Description |
| --- | --- |
| `name` | The portal name. |
| `requirePolicy(policy, options?)` | Returns a guard for `preHandler` or `onRequest`. Takes the unqualified name (`posts.read`, not `admin.posts.read`). `options.resource(req)` resolves the target row; required for scoped grants. |
| `contextHook()` | Resolves the user without guarding. For unguarded routes that still record ownership. Register per scope, never app-wide. |
| `assignGroup(subjectId, group, options?)` | Assign a group in this portal. `options.contextId` targets a tenant. |
| `removeGroup(subjectId, group, options?)` | Remove a group. |
| `assignPolicy(subjectId, policy, options?)` | Grant one policy. Unqualified name. `options`: `contextId`, `scope`. |
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
