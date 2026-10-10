# Fastify

Reference for `@kyrobit/kyroguard/fastify`. Requires Fastify 5.x. For a walkthrough, see [Fastify](/guide/fastify).

## kyroguardFastify()

```ts
import { kyroguardFastify } from '@kyrobit/kyroguard/fastify'

function kyroguardFastify(guard: Guard, options?: FastifyGuardOptions): FastifyPluginAsync
```

| Parameter | Type | Description |
| --- | --- | --- |
| `guard` | `Guard` | The instance from [`createGuard()`](/reference/core-api#createguard). |
| `options.formatError` | `(error: GuardError, req: FastifyRequest) => { status: number; body: unknown }` | Optional. Custom response body for denials. |

The plugin opens the request context on every request and decorates the app with `app.kyroguard`. Register it once. It is visible to the whole app, not only the registration scope.

```ts
import Fastify from 'fastify'
import { kyroguardFastify } from '@kyrobit/kyroguard/fastify'
import { guard } from './kyroguard/domains.js'

const app = Fastify()
await app.register(kyroguardFastify(guard))

const teachers = app.kyroguard.domain('teachers', {
  resources,
  getSubject: async req => {
    const user = await verifySession(req.headers.authorization)
    return user ? { id: user.id, tenant_id: user.schoolId } : null
  },
})

app.get('/grades', { preHandler: teachers.requirePolicy('grades.view') }, async () => {
  return { ok: true }
})
```

## createDomain()

```ts
import { createDomain } from '@kyrobit/kyroguard/fastify'

function createDomain(guard: Guard, name: string, options): FastifyDomain
```

| Parameter | Type | Description |
| --- | --- | --- |
| `guard` | `Guard` | The instance from [`createGuard()`](/reference/core-api#createguard). |
| `name` | `string` | Domain name. Required — every domain is named. |
| `options.getSubject` | `(req: FastifyRequest) => SubjectInput \| null` | Resolves the authenticated user. `null` → 401. |
| `options.resources` | `ResourceDefinition[]` | Required. This domain's resource definitions, registered on the guard at creation. |
| `options.formatError` | `(error: GuardError, req: FastifyRequest) => { status: number; body: unknown }` | Optional. Custom response body for denials. |

Creates the same [domain instance](#domain-instance) as [`app.kyroguard.domain`](#app-kyroguard), without needing the app — so domains are plain values a module exports and any route file imports. This is the pattern `kyroguard init` scaffolds in `src/kyroguard/domains.ts`:

```ts
// src/kyroguard/domains.ts
import { createGuard } from '@kyrobit/kyroguard'
import { createDomain } from '@kyrobit/kyroguard/fastify'
import { resources } from './policies/admin.js'

export const guard = createGuard({ adapter })
export const admin = createDomain(guard, 'admin', { resources, getSubject })
```

```ts
// routes/posts.ts
import { admin } from '../kyroguard/domains.js'

app.get('/posts/:id', { preHandler: admin.requirePolicy('posts.read') }, async () => {
  // ...
})
```

The plugin must still be registered once in your bootstrap — `await app.register(kyroguardFastify(guard))` opens the per-request context the guards run in. Without it, every guard throws `MisconfiguredError` (500).

## app.kyroguard

| Member | Description |
| --- | --- |
| `domain(name, options)` | Create a named [domain instance](#domain-instance) — one per app area, like `admin` and `teachers`. |
| `setSubject(subject)` | Set the active user directly (custom auth outside a domain). |
| `cache` | Cache control: `invalidateSubject(subjectId)`, `clear()`. |

## Domain instance

```ts
const admin = app.kyroguard.domain('admin', { resources, getSubject })
```

`options.getSubject(req)` returns the logged-in user, or `null` for a 401. It runs once per request per domain.

| Method | Description |
| --- | --- |
| `name` | The domain name. |
| `requirePolicy(policy)` | Returns a guard for `preHandler` or `onRequest`. Takes the unqualified name (`grades.view`, not `teachers.grades.view`). On allow, queries against the policy's resource are narrowed by this grant for the rest of the request ([automatic filtering](/guide/scopes#automatic-filtering)). |
| `filterFor(req, policy)` | The policy's list decision as a [`FilterResult`](/reference/core-api#filterfor), for queries you build yourself. |
| `can(req, policy)` | `Promise<boolean>` — does the subject hold this policy? Never throws: no user answers `false`, not 401. See [`can()`](/reference/core-api#can). |
| `grantsFor(req)` | `Promise<DomainGrants>` — every policy the subject holds in this domain, to serialize to a client. See [`grantsFor()`](/reference/core-api#grantsfor). |
| `subjectHook()` | Resolves the user without guarding. For unguarded routes that still record ownership. It activates no read filter. Register per scope, never app-wide. |
| `assignGroup(subjectId, group, options?)` | Assign a group in this domain. `options.tenantId` targets one school, like `school-1`. |
| `removeGroup(subjectId, group, options?)` | Remove a group. |
| `assignPolicy(subjectId, policy, options?)` | Grant one policy. Unqualified name. `options`: `tenantId`, `scope`. |
| `removePolicy(subjectId, policy, options?)` | Remove a direct grant. |

**Throws** `MisconfiguredError` (500) from any guard when `kyroguardFastify()` was not registered.

## Error responses

A denied guard throws the `GuardError` through Fastify's own error pipeline. Your `setErrorHandler`, `onSend` hooks and CORS headers keep running. The default serializer produces:

```json
// 403 — policy not granted
{ "statusCode": 403, "code": "ACCESS_DENIED", "error": "Forbidden", "message": "Forbidden" }

// 401 — getSubject returned null
{ "statusCode": 401, "code": "UNAUTHENTICATED", "error": "Unauthorized", "message": "Unauthorized" }
```

`ACCESS_DENIED` is the only denial a guard produces; a scope narrows the query instead of refusing the request. See [Errors](/reference/errors).

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
`formatError` only sees `GuardError` denials. An error thrown by your own `getSubject` goes to Fastify's error handler unchanged. Handle it there.
:::
