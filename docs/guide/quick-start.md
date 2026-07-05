# Quick start

In about ten minutes you build a guarded Fastify API with no database: the in-memory adapter stores policies and grants, you watch a request go from 401 to 403 to 200, and every response body below is what the code actually returns. When it clicks, you swap one line to move to a real database.

::: tip Prerequisites
Bun (or Node.js 20.19+ with [tsx](https://tsx.is)) and curl. The package is published to the GitHub Packages registry — if `bun add` cannot find `@kyrobit/rbac`, set up the `.npmrc` from [Installation, step 1](/guide/installation#_1-install-the-package) first.
:::

## 1. Create a project

```sh
mkdir rbac-quick-start && cd rbac-quick-start
bun init -y
bun add fastify @kyrobit/rbac
```

## 2. Write the server

Create `server.ts`. This is the whole app — read the comments top to bottom, they mirror the request lifecycle:

```ts
// server.ts
import Fastify from 'fastify'
import { createRbac, Policy } from '@kyrobit/rbac'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { memoryAdapter } from '@kyrobit/rbac/testing'
import type { ResourceDefinition } from '@kyrobit/rbac'

// One resource, one policy. Names are unqualified — the portal prefixes them.
const resources: ResourceDefinition[] = [
  { type: 'post', policies: [new Policy('posts.read')] },
]

// memoryAdapter() implements the full storage contract in memory —
// same behavior as the Drizzle, Prisma and Mongoose adapters, zero setup.
const rbac = createRbac({ adapter: memoryAdapter(), resources })

// Programmatic equivalent of the `rbac sync` CLI: store the policy
// catalog (as app.posts.read) and seed a group that grants it.
await rbac.sync(resources, 'app')
await rbac.seedGroups(
  { reader: { label: 'Reader', policies: ['posts.read'] } },
  undefined,
  'app',
)

const app = Fastify()
await app.register(rbacFastify(rbac))

// A portal named 'app'. getSubject turns a request into a subject;
// here a header stands in for real authentication.
const portal = app.rbac.portal('app', {
  getSubject: async request => {
    const id = request.headers['x-user-id']
    return typeof id === 'string' && id !== '' ? { id } : null
  },
})

// The guarded route: the preHandler checks app.posts.read at guard time.
app.get(
  '/posts',
  { preHandler: portal.requirePolicy('posts.read') },
  async () => [{ id: 'p_1', title: 'Hello' }],
)

// Tutorial-only: grants the reader group to any caller. Protect or delete
// this route before shipping anything.
app.post('/grant/:userId', async request => {
  const { userId } = request.params as { userId: string }
  await portal.assignGroup(userId, 'reader')
  return { granted: true, userId }
})

await app.listen({ port: 3000 })
console.log('quick start listening on http://localhost:3000')
```

## 3. Run it

```console
$ bun server.ts
quick start listening on http://localhost:3000
```

(On Node, run `npx tsx server.ts` instead.)

## 4. Request without a user — 401

No `x-user-id` header means `getSubject` returns `null`, so the guard throws `UnauthenticatedError` through Fastify's own error pipeline:

```console
$ curl -s http://localhost:3000/posts
{"statusCode":401,"code":"RBAC_UNAUTHENTICATED","error":"Unauthorized","message":"Unauthorized"}
```

## 5. Request as a user with no grant — 403

Now the subject resolves (`id: 'u_1'`, portal `app`), but the storage lookup finds no grant of `app.posts.read` for that exact (subject, portal, context) tuple, so the guard throws `PolicyDeniedError`:

```console
$ curl -s -H 'x-user-id: u_1' http://localhost:3000/posts
{"statusCode":403,"code":"RBAC_POLICY_DENIED","error":"Forbidden","message":"Forbidden"}
```

`RBAC_POLICY_DENIED` is one of five stable error codes — the full list is in the [error reference](/reference/errors).

## 6. Grant the group

`portal.assignGroup('u_1', 'reader')` records the assignment for portal `app` (the portal fills in its own name — grants are matched on portal by strict equality, so an assignment on the wrong portal never applies):

```console
$ curl -s -X POST http://localhost:3000/grant/u_1
{"granted":true,"userId":"u_1"}
```

The 403 in step 5 cached `u_1`'s empty policy map, but this works immediately anyway: assignment mutations invalidate the subject's cache entry through the engine's invalidation bus, so the next request re-reads storage.

## 7. Request again — 200

```console
$ curl -s -H 'x-user-id: u_1' http://localhost:3000/posts
[{"id":"p_1","title":"Hello"}]
```

The guard resolved the subject, found `app.posts.read` granted without a scope, and let the handler run.

::: warning Everything here resets on restart
`memoryAdapter()` keeps policies and grants in process memory — restart the server and `u_1` is back to 403 until you repeat the grant in step 6 (the `rbac.sync` and `seedGroups` calls re-seed the catalog on every boot, but grants are not re-seeded). It is built for tests and tutorials, not persistence. The `x-user-id` header and the open `/grant` route are stand-ins for real authentication and a real admin surface.
:::

## Move to a real database

Swap the adapter and everything else stays the same — the guard, the portal and the error bodies are identical on every backend:

```ts
import { memoryAdapter } from '@kyrobit/rbac/testing' // [!code --]
import { drizzleAdapter } from '@kyrobit/rbac/drizzle' // [!code ++]
```

[Installation](/guide/installation) walks through the full setup: scaffolding with `rbac init`, migrations, syncing from the CLI and wiring your real authentication.

## Next steps

- [Installation](/guide/installation) — the same flow on PostgreSQL, MySQL, SQLite or MongoDB.
- [Defining policies](/guide/defining-policies) — dependencies, scopes and resource definitions.
- [Testing your app](/guide/testing-your-app) — `memoryAdapter` is also the fastest way to test guarded routes.
