# Express

Reference for `@kyrobit/kyroguard/express`. Works on Express 4.18+ and Express 5. For a walkthrough, see [Express](/guide/express).

## kyroguardExpress()

```ts
import { kyroguardExpress } from '@kyrobit/kyroguard/express'

function kyroguardExpress(guard: Guard, options?: ExpressGuardOptions): ExpressGuard
```

| Parameter | Type | Description |
| --- | --- | --- |
| `guard` | `Guard` | The instance from [`createGuard()`](/reference/core-api#createguard). |
| `options.formatError` | `(error: GuardError, req: Request) => { status: number; body: unknown }` | Optional. Custom response body for denials. |

**Returns** three factories:

| Member | Description |
| --- | --- |
| `context()` | Middleware that opens the request context. Register once, before any guard. |
| `domain(name, options)` | Create a named [domain instance](#domain-instance) — one per app area, like `admin` and `teachers`. |
| `domain(options)` | Domain-less overload for single-area apps. Policy names stay unprefixed. |
| `errorHandler()` | Error middleware that sends the denial response. Register after your routes. |

```ts
import express from 'express'
import { kyroguardExpress } from '@kyrobit/kyroguard/express'
import { guard } from './kyroguard/domains.js'

const app = express()
const { context, domain, errorHandler } = kyroguardExpress(guard)

app.use(context()) // before any guard

const teachers = domain({
  getSubject: async req => {
    const user = await verifySession(req.headers.authorization)
    return user ? { id: user.id, tenant_id: user.schoolId } : null
  },
})

app.get('/grades', teachers.requirePolicy('grades.view'), (req, res) => {
  res.json({ ok: true })
})

app.use(errorHandler()) // after the routes
```

## Domain instance

```ts
const teachers = domain({ getSubject })       // single-area app
const admin = domain('admin', { getSubject }) // multi-area app
```

`options.getSubject(req)` returns the logged-in user, or `null` for a 401. It runs once per request per domain.

`createDomain(guard, name?, options)` is also exported from the subpath — the same factory without calling `kyroguardExpress` first, for modules that only define domains (`src/kyroguard/domains.ts`). Pass the domain's `resources` there and the guard registers them for you.

| Method | Description |
| --- | --- |
| `name` | The domain name. `''` for the domain-less overload. |
| `requirePolicy(policy, options?)` | Guard middleware. Takes the unqualified name (`grades.view`, not `teachers.grades.view`). `options.resource(req)` resolves the target row for scoped grants; when omitted, the guard defaults to the policy's resource type plus the route's `:id` param when both exist. On allow, reads of the policy's resource are filtered by this grant for the rest of the request ([automatic filtering](/guide/scopes#automatic-filtering)). |
| `filterFor(req, policy)` | The policy's list decision as a [`FilterResult`](/reference/core-api#filterfor), for queries you build yourself. |
| `subjectHook()` | Resolves the user without guarding. For unguarded routes that still record ownership. It activates no read filter. Mount on specific routers, never app-wide. |
| `assignGroup(subjectId, group, options?)` | Assign a group in this domain. `options.tenantId` targets one school, like `school-1`. |
| `removeGroup(subjectId, group, options?)` | Remove a group. |
| `assignPolicy(subjectId, policy, options?)` | Grant one policy. Unqualified name. `options`: `tenantId`, `scope`. |
| `removePolicy(subjectId, policy, options?)` | Remove a direct grant. |

Guards never write responses. A denial travels through `next(err)` into your error pipeline. Behavior is identical on Express 4 and Express 5.

**Throws** `MisconfiguredError` (500) from any guard when `context()` is not mounted in front of it.

## errorHandler()

```ts
app.use(errorHandler())
```

For a `GuardError` it responds with `error.statusCode` and a JSON body. Everything else is passed to `next(error)`, so your own error middleware still applies.

```json
// 403 — policy not granted
{ "message": "Forbidden", "code": "ACCESS_DENIED", "reason": "policy" }

// 401 — getSubject returned null
{ "message": "Unauthorized", "code": "UNAUTHENTICATED" }
```

A failed scope check produces `ACCESS_DENIED` with `"reason": "scope"`, and a scoped grant whose resource is missing produces `NOT_FOUND` (404) the same way. See [Errors](/reference/errors).

### formatError

Pass `formatError` to shape the denial response yourself:

```ts
const { context, domain, errorHandler } = kyroguardExpress(guard, {
  formatError: (error, req) => ({
    status: error.statusCode,
    body: { code: error.code, path: req.path },
  }),
})
```

::: warning
Without `errorHandler()`, a denial falls through to Express's default handler. That renders an HTML error page instead of JSON. Always register it after the last route.
:::
