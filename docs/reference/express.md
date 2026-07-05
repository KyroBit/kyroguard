# Express

Reference for `@kyrobit/rbac/express`. Works on Express 4.18+ and Express 5. For a walkthrough, see [Setting up Express](/guide/setting-up-express).

## rbacExpress()

```ts
import { rbacExpress } from '@kyrobit/rbac/express'

function rbacExpress(rbac: Rbac, options?: ExpressRbacOptions): ExpressRbac
```

| Parameter | Type | Description |
| --- | --- | --- |
| `rbac` | `Rbac` | The instance from [`createRbac()`](/reference/core-api#createrbac). |
| `options.formatError` | `(error: RbacError, req: Request) => { status: number; body: unknown }` | Optional. Overrides the default error response rendered by `errorHandler()`. |

**Returns** `ExpressRbac`:

```ts
interface ExpressRbac {
  context(): RequestHandler
  portal<P extends string>(
    name: P,
    options: PortalOptions<Request>,
  ): PortalInstance<Request, RequestHandler, P>
  errorHandler(): ErrorRequestHandler
}
```

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

## context()

```ts
context(): RequestHandler
```

Opens the engine's per-request `AsyncLocalStorage` store. Register it once, before any portal guard. It calls `store.enter(next)` — the callback form is mandatory because under Bun a promise-wrapped `store.run()` does not propagate ALS context to the rest of the middleware chain.

Any guard that runs without `context()` in front of it throws `MisconfiguredError` (500, `RBAC_MISCONFIGURED`).

## portal()

```ts
portal<P extends string>(name: P, options: PortalOptions<Request>): PortalInstance<Request, RequestHandler, P>
```

`options.getSubject: (req: Request) => Awaitable<SubjectInput | null>` — called lazily at guard time, memoized per request per portal; return `null` when the request has no authenticated user (→ 401). The portal adds `portal: name` to the returned subject itself. Registering a portal never touches app-wide state, so two portals on one app cannot overwrite each other's subject.

### Portal instance

| Method | Signature | Description |
| --- | --- | --- |
| `name` | `P` | The portal name. |
| `requirePolicy` | `(policy: PortalPolicyName<P>, options?: { resource?: (req) => Awaitable<ResourceRef \| null \| undefined> }) => RequestHandler` | Guard middleware. Takes the **unqualified** policy name — the portal qualifies it (`admin` + `posts.read` → `admin.posts.read`). `resource` resolves the row-level target; required whenever the resolved grant is scoped, otherwise the guard denies with `ScopeDeniedError`. |
| `contextHook` | `() => RequestHandler` | Resolves and sets the subject without guarding — for unguarded routes that still need ownership tracking. Mount it on specific routers, never app-wide. |
| `assignGroup` | `(subjectId: string, group: string, options?: { contextId?: string }) => Promise<void>` | Assignment sugar, strict to this portal. |
| `removeGroup` | `(subjectId: string, group: string, options?: { contextId?: string }) => Promise<void>` | Same. |
| `assignPolicy` | `(subjectId: string, policy: PortalPolicyName<P>, options?: { contextId?: string; scope?: string \| null }) => Promise<void>` | Takes the unqualified name and qualifies it with the portal. |
| `removePolicy` | `(subjectId: string, policy: PortalPolicyName<P>, options?: { contextId?: string }) => Promise<void>` | Same. |

## Guard semantics

Guards never write responses. A denial travels through `next(err)` into the app's error pipeline, terminated by `errorHandler()`. Rejections are forwarded explicitly, so behavior is identical on Express 4 (which has no automatic async error forwarding) and Express 5. Two invariants:

- `next()` is called only on fulfillment, outside any catch path, so a throw from downstream middleware can never re-enter `next(err)` inside the guard.
- A falsy rejection (`Promise.reject()`) is upgraded to a `MisconfiguredError` — Express treats `next(undefined)` as success, which would authorize the request.

## errorHandler()

```ts
errorHandler(): ErrorRequestHandler
```

Terminal error middleware. Register it after your routes. For an `RbacError` it responds with `error.statusCode` and `error.toBody()` as JSON; everything else — non-`RbacError` errors, or any error arriving after headers were already sent — is delegated to `next(error)` so your own error middleware and Express defaults still apply.

Default denied responses:

```json
// 403 — policy not granted
{ "message": "Forbidden", "code": "RBAC_POLICY_DENIED" }

// 401 — getSubject returned null
{ "message": "Unauthorized", "code": "RBAC_UNAUTHENTICATED" }
```

Scoped denials produce `RBAC_SCOPE_DENIED` (403) and `RBAC_RESOURCE_NOT_FOUND` (404) the same way. See [Errors](/reference/errors) for every code.

With `formatError` set on `rbacExpress()`, the handler responds with your `{ status, body }` instead:

```ts
const { context, portal, errorHandler } = rbacExpress(rbac, {
  formatError: (error, req) => ({
    status: error.statusCode,
    body: { code: error.code, path: req.path },
  }),
})
```

::: warning
Without `errorHandler()` (or your own error middleware that understands `RbacError`), a denial falls through to Express's default handler, which renders an HTML error page (including a stack trace outside production) instead of the JSON body API clients expect. Always register `errorHandler()` after the last route.
:::
