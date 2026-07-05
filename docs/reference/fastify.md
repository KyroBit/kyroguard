# Fastify

Reference for `@kyrobit/rbac/fastify`. Requires Fastify 5.x. For a walkthrough, see [Setting up Fastify](/guide/setting-up-fastify).

## rbacFastify()

```ts
import { rbacFastify } from '@kyrobit/rbac/fastify'

function rbacFastify(rbac: Rbac, options?: RbacFastifyOptions): FastifyPluginAsync
```

Creates the Fastify plugin. It is wrapped with `fastify-plugin` (name `@kyrobit/rbac`, `fastify: '5.x'`), so registering it once makes the decorator visible to the whole app, not only the registration scope.

| Parameter | Type | Description |
| --- | --- | --- |
| `rbac` | `Rbac` | The instance from [`createRbac()`](/reference/core-api#createrbac). |
| `options.formatError` | `(error: RbacError, req: FastifyRequest) => { status: number; body: unknown }` | Optional. Overrides the default error response for `RbacError` denials. |

On registration the plugin:

1. Adds an `onRequest` hook that opens the engine's per-request `AsyncLocalStorage` store. The hook uses the callback form on purpose: under Bun, ALS context does not propagate out of `await new Promise(resolve => store.run(..., resolve))`.
2. Decorates the instance with `app.rbac`.

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

## app.rbac (FastifyRbacDecoration)

```ts
interface FastifyRbacDecoration {
  portal<P extends string>(name: P, options: PortalOptions<FastifyRequest>): FastifyPortal<P>
  setSubject(subject: Subject): void
  addExtra(extra: Record<string, unknown>): void
  readonly cache: Rbac['cache']
}
```

| Member | Description |
| --- | --- |
| `portal(name, options)` | Creates a [portal instance](#fastifyportal-portal-instance). `options.getSubject: (req) => Awaitable<SubjectInput \| null>` — called lazily at guard time, memoized per request per portal; return `null` when the request has no authenticated user (→ 401). The portal adds `portal: name` to the returned subject itself. |
| `setSubject(subject)` | Sets the active subject on the current request store directly (custom auth flows outside a portal). |
| `addExtra(extra)` | One-shot overrides for the next tracked insert — see [`rbac.ownership.addExtra`](/reference/core-api#rbac-ownership). |
| `cache` | The instance's cache control: `invalidateSubject(subjectId)`, `clear()`. |

Registering a portal never installs an app-wide hook, so two portals on one app can never overwrite each other's subject.

## FastifyPortal (portal instance)

```ts
type FastifyRbacGuard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>
type FastifyPortal<P extends string = string> = PortalInstance<FastifyRequest, FastifyRbacGuard, P>
```

| Method | Signature | Description |
| --- | --- | --- |
| `name` | `P` | The portal name. |
| `requirePolicy` | `(policy: PortalPolicyName<P>, options?: { resource?: (req) => Awaitable<ResourceRef \| null \| undefined> }) => FastifyRbacGuard` | Returns an async guard for `preHandler`/`onRequest` hook slots. Takes the **unqualified** policy name — the portal qualifies it (`admin` + `posts.read` → `admin.posts.read`). `resource` resolves the row-level target; required whenever the resolved grant is scoped, otherwise the guard denies with `ScopeDeniedError`. |
| `contextHook` | `() => FastifyRbacGuard` | Resolves and sets the subject without guarding — for unguarded routes that still need ownership tracking. Register it in an encapsulated scope, never app-wide. |
| `assignGroup` | `(subjectId: string, group: string, options?: { contextId?: string }) => Promise<void>` | Assignment sugar, strict to this portal. |
| `removeGroup` | `(subjectId: string, group: string, options?: { contextId?: string }) => Promise<void>` | Same. |
| `assignPolicy` | `(subjectId: string, policy: PortalPolicyName<P>, options?: { contextId?: string; scope?: string \| null }) => Promise<void>` | Takes the unqualified name and qualifies it with the portal. |
| `removePolicy` | `(subjectId: string, policy: PortalPolicyName<P>, options?: { contextId?: string }) => Promise<void>` | Same. |

`getSubject` runs at most once per request per portal — the result (including `null`) is memoized, so a failed resolution is not retried across stacked guards, and two portals on one app resolve independent subjects.

**Throws** `MisconfiguredError` (500, `RBAC_MISCONFIGURED`) from any guard when `rbacFastify()` was not registered on the instance handling the request.

## Error behavior

By default a denied guard **throws** the `RbacError` through Fastify's own error pipeline — your `setErrorHandler`, `onSend` hooks and CORS headers all keep running. `RbacError` carries `statusCode` and `code`, so Fastify's default serializer produces a correct response without configuration:

```json
// 403 — policy not granted
{ "statusCode": 403, "code": "RBAC_POLICY_DENIED", "error": "Forbidden", "message": "Forbidden" }

// 401 — getSubject returned null
{ "statusCode": 401, "code": "RBAC_UNAUTHENTICATED", "error": "Unauthorized", "message": "Unauthorized" }
```

Scoped denials produce `RBAC_SCOPE_DENIED` (403) and `RBAC_RESOURCE_NOT_FOUND` (404) the same way. See [Errors](/reference/errors) for every code.

### formatError

```ts
formatError?: (error: RbacError, req: FastifyRequest) => { status: number; body: unknown }
```

When provided, the guard renders the denial itself: `reply.code(status)`, `reply.send(body)`, then returns the reply object. Returning the reply marks the response as handled without hijacking the socket, so `onSend` hooks and CORS headers still run. Non-`RbacError` exceptions (from `getSubject` or a `resource` resolver) always throw through the normal pipeline, formatted or not.

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

::: warning
`formatError` only sees `RbacError` denials. Errors thrown by your `getSubject` implementation are not authorization decisions and go to Fastify's error handler unchanged — handle them there.
:::
