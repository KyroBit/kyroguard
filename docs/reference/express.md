# Express

Reference for `@kyrobit/rbac/express`. Works on Express 4.18+ and Express 5. For a walkthrough, see [Express](/guide/express).

## rbacExpress()

```ts
import { rbacExpress } from '@kyrobit/rbac/express'

function rbacExpress(rbac: Rbac, options?: ExpressRbacOptions): ExpressRbac
```

| Parameter | Type | Description |
| --- | --- | --- |
| `rbac` | `Rbac` | The instance from [`createRbac()`](/reference/core-api#createrbac). |
| `options.formatError` | `(error: RbacError, req: Request) => { status: number; body: unknown }` | Optional. Custom response body for denials. |

**Returns** three factories:

| Member | Description |
| --- | --- |
| `context()` | Middleware that opens the request context. Register once, before any guard. |
| `portal(name, options)` | Create a [portal instance](#portal-instance). `options.getSubject(req)` returns the logged-in user, or `null` for a 401. It runs once per request per portal. |
| `errorHandler()` | Error middleware that sends the denial response. Register after your routes. |

```ts
import express from 'express'
import { rbacExpress } from '@kyrobit/rbac/express'
import { rbac } from './rbac.js'

const app = express()
const { context, portal, errorHandler } = rbacExpress(rbac)

app.use(context()) // before any guard

const admin = portal('admin', {
  getSubject: async req => {
    const user = await verifySession(req.headers.authorization)
    return user ? { id: user.id, context_id: user.branchId } : null
  },
})

app.get('/posts', admin.requirePolicy('posts.read'), (req, res) => {
  res.json({ ok: true })
})

app.use(errorHandler()) // after the routes
```

## Portal instance

| Method | Description |
| --- | --- |
| `name` | The portal name. |
| `requirePolicy(policy, options?)` | Guard middleware. Takes the unqualified name (`posts.read`, not `admin.posts.read`). `options.resource(req)` resolves the target row; required for scoped grants. |
| `contextHook()` | Resolves the user without guarding. For unguarded routes that still record ownership. Mount on specific routers, never app-wide. |
| `assignGroup(subjectId, group, options?)` | Assign a group in this portal. `options.contextId` targets a tenant. |
| `removeGroup(subjectId, group, options?)` | Remove a group. |
| `assignPolicy(subjectId, policy, options?)` | Grant one policy. Unqualified name. `options`: `contextId`, `scope`. |
| `removePolicy(subjectId, policy, options?)` | Remove a direct grant. |

Guards never write responses. A denial travels through `next(err)` into your error pipeline. Behavior is identical on Express 4 and Express 5.

**Throws** `MisconfiguredError` (500) from any guard when `context()` is not mounted in front of it.

## errorHandler()

```ts
app.use(errorHandler())
```

For an `RbacError` it responds with `error.statusCode` and a JSON body. Everything else is passed to `next(error)`, so your own error middleware still applies.

```json
// 403 — policy not granted
{ "message": "Forbidden", "code": "RBAC_POLICY_DENIED" }

// 401 — getSubject returned null
{ "message": "Unauthorized", "code": "RBAC_UNAUTHENTICATED" }
```

Scoped denials produce `RBAC_SCOPE_DENIED` (403) and `RBAC_RESOURCE_NOT_FOUND` (404) the same way. See [Errors](/reference/errors).

### formatError

Pass `formatError` to shape the denial response yourself:

```ts
const { context, portal, errorHandler } = rbacExpress(rbac, {
  formatError: (error, req) => ({
    status: error.statusCode,
    body: { code: error.code, path: req.path },
  }),
})
```

::: warning
Without `errorHandler()`, a denial falls through to Express's default handler. That renders an HTML error page instead of JSON. Always register it after the last route.
:::
