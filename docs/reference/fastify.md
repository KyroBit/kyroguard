# Fastify

Reference for `@kyrobit/kyroguard/fastify`. Requires Fastify 5.x. For a walkthrough, see [Fastify](/guide/fastify).

## kyroguardFastify()

```ts
import { kyroguardFastify } from '@kyrobit/kyroguard/fastify'

function kyroguardFastify(guard: Kyroguard, options?: KyroguardFastifyOptions): FastifyPluginAsync
```

| Parameter | Type | Description |
| --- | --- | --- |
| `rbac` | `Kyroguard` | The instance from [`createKyroguard()`](/reference/core-api#createrbac). |
| `options.formatError` | `(error: KyroguardError, req: FastifyRequest) => { status: number; body: unknown }` | Optional. Custom response body for denials. |

The plugin opens the request context on every request and decorates the app with `app.kyroguard`. Register it once. It is visible to the whole app, not only the registration scope.

```ts
import Fastify from 'fastify'
import { kyroguardFastify } from '@kyrobit/kyroguard/fastify'
import { guard } from './rbac.js'

const app = Fastify()
await app.register(kyroguardFastify(guard))

const teachers = app.kyroguard.domain({
  getSubject: async req => {
    const user = await verifySession(req.headers.authorization)
    return user ? { id: user.id, tenant_id: user.schoolId } : null
  },
})

app.get('/grades', { preHandler: teachers.requirePolicy('grades.view') }, async () => {
  return { ok: true }
})
```

## app.kyroguard

| Member | Description |
| --- | --- |
| `domain(name, options)` | Create a named [domain instance](#domain-instance) — one per app area, like `admin` and `teachers`. |
| `domain(options)` | Domain-less overload for single-area apps. Policy names stay unprefixed. |
| `setSubject(subject)` | Set the active user directly (custom auth outside a domain). |
| `addExtra(extra)` | Override the next tracked insert's ownership row. Applies once. See [ownership](/reference/core-api#kyroguard). |
| `cache` | Cache control: `invalidateSubject(subjectId)`, `clear()`. |

## Domain instance

```ts
const teachers = app.kyroguard.domain({ getSubject })       // single-area app
const admin = app.kyroguard.domain('admin', { getSubject }) // multi-area app
```

`options.getSubject(req)` returns the logged-in user, or `null` for a 401. It runs once per request per domain.

| Method | Description |
| --- | --- |
| `name` | The domain name. `''` for the domain-less overload. |
| `requirePolicy(policy, options?)` | Returns a guard for `preHandler` or `onRequest`. Takes the unqualified name (`grades.view`, not `teachers.grades.view`). `options.resource(req)` resolves the target row for scoped grants; when omitted, the guard defaults to the policy's resource type plus the route's `:id` param when both exist. On allow, reads of the policy's resource are filtered by this grant for the rest of the request ([automatic filtering](/guide/scopes#automatic-filtering)). |
| `filterFor(req, policy)` | The policy's list decision as a [`FilterResult`](/reference/core-api#filterfor), for queries you build yourself. |
| `subjectHook()` | Resolves the user without guarding. For unguarded routes that still record ownership. It activates no read filter. Register per scope, never app-wide. |
| `assignGroup(subjectId, group, options?)` | Assign a group in this domain. `options.tenantId` targets one school, like `school-1`. |
| `removeGroup(subjectId, group, options?)` | Remove a group. |
| `assignPolicy(subjectId, policy, options?)` | Grant one policy. Unqualified name. `options`: `tenantId`, `scope`. |
| `removePolicy(subjectId, policy, options?)` | Remove a direct grant. |

**Throws** `MisconfiguredError` (500) from any guard when `kyroguardFastify()` was not registered.

## Error responses

A denied guard throws the `KyroguardError` through Fastify's own error pipeline. Your `setErrorHandler`, `onSend` hooks and CORS headers keep running. The default serializer produces:

```json
// 403 — policy not granted
{ "statusCode": 403, "code": "ACCESS_DENIED", "error": "Forbidden", "message": "Forbidden" }

// 401 — getSubject returned null
{ "statusCode": 401, "code": "UNAUTHENTICATED", "error": "Unauthorized", "message": "Unauthorized" }
```

A failed scope check produces the same `ACCESS_DENIED` body, and a scoped grant whose resource is missing produces `NOT_FOUND` (404). The default serializer has a fixed shape and does not include the error's `reason` field — return `error.toBody()` from `formatError` (or use `setErrorHandler`) to expose `reason: 'policy' | 'scope'`. See [Errors](/reference/errors).

### formatError

Pass `formatError` to shape the denial response yourself:

```ts
await app.register(
  kyroguardFastify(guard, {
    formatError: (error, req) => ({
      status: error.statusCode,
      body: { code: error.code, path: req.url },
    }),
  }),
)
```

`onSend` hooks and CORS headers still run on formatted responses.

::: warning
`formatError` only sees `KyroguardError` denials. An error thrown by your own `getSubject` goes to Fastify's error handler unchanged. Handle it there.
:::
