# Setting up Fastify

You register `@kyrobit/rbac` on a Fastify app, create a portal, and protect a first route. Along the way you see exactly what a denied request returns and how to change that shape.

::: tip Prerequisites
You need a configured `Rbac` instance backed by a storage adapter, with the rbac tables migrated and your policies synced (`rbac sync`) — see [Installation](/guide/installation). The examples use the starter `post` resource from `src/rbac/policies.ts`. The integration requires Fastify 5.
:::

## 1. Register the plugin

```ts
import Fastify from 'fastify'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { rbac } from './rbac/instance.js' // your createRbac(...) instance

const app = Fastify({ logger: true })
await app.register(rbacFastify(rbac))
```

Registration does exactly two things:

- adds **one** `onRequest` hook that opens the per-request rbac context — the store where guards memoize resolved subjects and where ownership tracking finds the current user, and
- decorates the instance with `app.rbac`.

It installs no per-portal hooks, no error handler and no reply serializer. All authorization work happens lazily inside route-level guards, so a request to an unguarded route costs one empty store allocation and nothing else.

::: warning Await the registration
`app.rbac` exists only after `await app.register(rbacFastify(rbac))` resolves. Calling `app.rbac.portal(...)` before that fails at boot with `TypeError: Cannot read properties of undefined`. The plugin also declares `fastify: '5.x'`, so registering it on Fastify 4 fails at startup with a version mismatch.
:::

## 2. Create a portal

```ts
const admin = app.rbac.portal('admin', {
  // Called lazily at guard time, memoized per request per portal.
  // Return null when the request has no authenticated user → 401.
  getSubject: async request => {
    const id = request.headers['x-user-id'] // demo only — see the note below
    return typeof id === 'string' && id !== '' ? { id } : null
  },
})
```

Creating a portal registers nothing on the app — no hook, no route, no decorator. The subject is resolved when the first guard on a request runs, and memoized per request **per portal**; two portals on one app can never overwrite each other's subject, because each guard reads its own portal's memoized entry instead of a shared slot written by a global hook.

Replace the header lookup with your real session or JWT resolution — see [Resolving the subject](/guide/resolving-the-subject).

## 3. Protect a route

Attach guards per route via `preHandler` (they are also compatible with the `onRequest` slot). Policy names are unqualified — the `admin` portal checks the stored grant `admin.posts.read`:

```ts
app.get(
  '/posts/:id',
  { preHandler: admin.requirePolicy('posts.read') },
  async request => {
    const { id } = request.params as { id: string }
    return { id, title: 'Hello' }
  },
)
```

Policies granted with a scope (row-level check, for example `owned`) additionally need a resource resolver so the scope knows which row is being touched:

```ts
app.patch(
  '/posts/:id',
  {
    preHandler: admin.requirePolicy('posts.update', {
      resource: request => ({ type: 'post', id: (request.params as { id: string }).id }),
    }),
  },
  async request => {
    // update the post
  },
)
```

The full decision table — which check produces which status and `RBAC_*` code — is in [Protecting routes](/guide/protecting-routes).

## 4. Put it together

A complete server file, using the Drizzle PostgreSQL adapter:

```ts
// src/server.ts
import Fastify from 'fastify'
import { drizzle } from 'drizzle-orm/node-postgres'
import { createRbac } from '@kyrobit/rbac'
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from '@kyrobit/rbac/drizzle/schema/pg'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { resources } from './rbac/policies.js'

const db = drizzle(process.env.DATABASE_URL!)
const rbac = createRbac({ adapter: drizzleAdapter(db, { schema }), resources })

const app = Fastify({ logger: true })
await app.register(rbacFastify(rbac))

const admin = app.rbac.portal('admin', {
  getSubject: async request => {
    const id = request.headers['x-user-id']
    return typeof id === 'string' && id !== '' ? { id } : null
  },
})

// Demo grant so the curl calls below work. Assignments are idempotent
// upserts; this requires `rbac sync` to have created the policy rows.
await admin.assignPolicy('u1', 'posts.read')

app.get(
  '/posts/:id',
  { preHandler: admin.requirePolicy('posts.read') },
  async request => ({ id: (request.params as { id: string }).id, title: 'Hello' }),
)

await app.listen({ port: 3000 })
```

Exercise all three outcomes:

```sh
curl -s localhost:3000/posts/1 -H 'x-user-id: u1'   # 200 — granted
curl -s localhost:3000/posts/1                      # 401 — no subject
curl -s localhost:3000/posts/1 -H 'x-user-id: u2'   # 403 — no grant
```

## How denied requests surface

Guards **throw** typed errors — `UnauthenticatedError`, `PolicyDeniedError`, `ScopeDeniedError`, `ResourceNotFoundError`, all exported from `@kyrobit/rbac` — through Fastify's own error pipeline. The reply is never hijacked and nothing is written to the raw socket, so:

- your `setErrorHandler` receives the typed error and can rebrand it, and
- your `onSend` hooks — CORS headers, compression, audit logging — run on denied responses exactly as on successful ones.

With no custom error handler, Fastify's default serializer produces this 403 for a missing policy:

```json
{
  "statusCode": 403,
  "code": "RBAC_POLICY_DENIED",
  "error": "Forbidden",
  "message": "Forbidden"
}
```

and this 401 when `getSubject` returns `null`:

```json
{
  "statusCode": 401,
  "code": "RBAC_UNAUTHENTICATED",
  "error": "Unauthorized",
  "message": "Unauthorized"
}
```

`code` and `message` come from the thrown `RbacError`; `statusCode` and `error` are added by Fastify's default error serializer. A custom error handler sees the error before any serialization:

```ts
import { RbacError } from '@kyrobit/rbac'

app.setErrorHandler((error, request, reply) => {
  if (error instanceof RbacError) {
    return reply
      .code(error.statusCode)
      .send({ error: { code: error.code, message: error.message } })
  }
  reply.send(error)
})
```

## Changing the shape with formatError

To reshape rbac denials without writing a full `setErrorHandler`, pass `formatError` at registration:

```ts
await app.register(
  rbacFastify(rbac, {
    formatError: (error, request) => ({
      status: error.statusCode,
      body: { code: error.code, message: error.message, path: request.url },
    }),
  }),
)
```

`formatError` applies only to `RbacError` instances thrown by guards. The guard then sends the reply itself instead of throwing, so your `setErrorHandler` is not invoked for those errors — `onSend` hooks still run, because the reply goes through the normal send pipeline.

## Tracking ownership on unguarded routes

Guards resolve the subject as a side effect, and ownership tracking attributes inserts to that subject. A route without a guard never resolves a subject, so tracked inserts on it are attributed to nobody. `portal.contextHook()` resolves and sets the subject **without** authorizing anything — register it in an encapsulated scope around exactly the routes that need it:

```ts
await app.register(async scope => {
  scope.addHook('preHandler', admin.contextHook())

  // No policy guard: any authenticated user may create a draft, but the
  // tracked insert (or rbac.ownership.record) still knows who the author is.
  scope.post('/drafts', async request => {
    // create the draft; ownership is attributed to the resolved subject
  })
})
```

Keep it scoped rather than app-wide: an app-wide hook would run this portal's `getSubject` on every request — including routes that belong to another portal, whose ownership rows would then be attributed to the wrong portal's subject.

## Next steps

- [Resolving the subject](/guide/resolving-the-subject) — the `getSubject` contract, subject shape, JWT and session wiring.
- [Protecting routes](/guide/protecting-routes) — the guard decision table and scoped grants.
- [Error reference](/reference/errors) — every `RBAC_*` code in one place.
