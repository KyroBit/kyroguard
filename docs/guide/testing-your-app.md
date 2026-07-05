# Testing your app

In this guide you test guarded routes without a database: `memoryAdapter()` is a complete in-memory storage backend, so each test builds a fresh rbac instance, seeds grants programmatically, and drives real HTTP requests in milliseconds.

::: tip Prerequisites
You have guards on routes ([Protecting routes](/guide/protecting-routes)) and know which policies your app defines ([Defining policies](/guide/defining-policies)).
:::

## Testing guarded routes with memoryAdapter()

`memoryAdapter()` (from `@kyrobit/rbac/testing`) implements the full storage contract in process memory. It behaves exactly like the Drizzle, Prisma and Mongoose adapters — same strict portal/context matching, same `UnknownPolicyError` on unsynced policies — because it is the reference implementation the real adapters are verified against.

1. Build a per-test app factory: fresh adapter, fresh rbac, fresh app. Sync policies in setup — assignments reference stored policies, so seeding before syncing fails the same way production does.

2. Seed grants with the same APIs you use in production: `portal.assignPolicy(...)`, `portal.assignGroup(...)`, `rbac.seedGroups(...)`, `rbac.ownership.record(...)`.

3. Drive HTTP and assert both outcomes — the allow and the exact denied body.

A complete test file:

::: code-group

```ts [Fastify (inject)]
// tests/posts.routes.test.ts
import Fastify from 'fastify'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Policy, Scope, createRbac } from '@kyrobit/rbac'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { memoryAdapter } from '@kyrobit/rbac/testing'
import type { ResourceDefinition } from '@kyrobit/rbac'

const resources: ResourceDefinition[] = [
  {
    type: 'post',
    policies: [
      new Policy('posts.read'),
      new Policy('posts.update', 'Update posts', ['posts.read'], [Scope.owned()]),
    ],
  },
]

async function makeApp() {
  const rbac = createRbac({ adapter: memoryAdapter(), resources, cache: false })
  await rbac.sync(resources, 'admin')

  const app = Fastify()
  await app.register(rbacFastify(rbac))

  const portal = app.rbac.portal('admin', {
    // Test auth: trust a header. Returning null → 401.
    getSubject: async request => {
      const id = request.headers['x-user-id']
      return typeof id === 'string' && id.length > 0 ? { id } : null
    },
  })

  app.get('/posts', { preHandler: portal.requirePolicy('posts.read') }, async () => [])

  app.patch(
    '/posts/:id',
    {
      preHandler: portal.requirePolicy('posts.update', {
        resource: request => ({ type: 'post', id: (request.params as { id: string }).id }),
      }),
    },
    async () => ({ ok: true }),
  )

  await app.ready()
  return { app, rbac, portal }
}

let ctx: Awaited<ReturnType<typeof makeApp>>

beforeEach(async () => {
  ctx = await makeApp()
})

afterEach(async () => {
  await ctx.app.close()
  ctx.rbac.dispose()
})

test('unauthenticated request → 401 RBAC_UNAUTHENTICATED', async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/posts' })
  expect(res.statusCode).toBe(401)
  expect(res.json()).toMatchObject({ code: 'RBAC_UNAUTHENTICATED', message: 'Unauthorized' })
})

test('authenticated without the grant → 403 RBAC_POLICY_DENIED', async () => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/posts',
    headers: { 'x-user-id': 'u1' },
  })
  expect(res.statusCode).toBe(403)
  expect(res.json()).toMatchObject({ code: 'RBAC_POLICY_DENIED', message: 'Forbidden' })
})

test('granted → 200', async () => {
  await ctx.portal.assignPolicy('u1', 'posts.read')
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/posts',
    headers: { 'x-user-id': 'u1' },
  })
  expect(res.statusCode).toBe(200)
})

test('owned scope: owner passes, everyone else gets RBAC_SCOPE_DENIED', async () => {
  await ctx.portal.assignPolicy('u1', 'posts.update', { scope: 'owned' })
  await ctx.portal.assignPolicy('u2', 'posts.update', { scope: 'owned' })
  await ctx.rbac.ownership.record('u1', { type: 'post', id: 'p1' })

  const owner = await ctx.app.inject({
    method: 'PATCH',
    url: '/posts/p1',
    headers: { 'x-user-id': 'u1' },
  })
  expect(owner.statusCode).toBe(200)

  const other = await ctx.app.inject({
    method: 'PATCH',
    url: '/posts/p1',
    headers: { 'x-user-id': 'u2' },
  })
  expect(other.statusCode).toBe(403)
  expect(other.json()).toMatchObject({ code: 'RBAC_SCOPE_DENIED', message: 'Forbidden' })
})
```

```ts [Express (fetch)]
// tests/posts.routes.test.ts
import express from 'express'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Policy, Scope, createRbac } from '@kyrobit/rbac'
import { rbacExpress } from '@kyrobit/rbac/express'
import { memoryAdapter } from '@kyrobit/rbac/testing'
import type { ResourceDefinition } from '@kyrobit/rbac'
import type { Server } from 'node:http'

const resources: ResourceDefinition[] = [
  {
    type: 'post',
    policies: [
      new Policy('posts.read'),
      new Policy('posts.update', 'Update posts', ['posts.read'], [Scope.owned()]),
    ],
  },
]

async function makeApp() {
  const rbac = createRbac({ adapter: memoryAdapter(), resources, cache: false })
  await rbac.sync(resources, 'admin')

  const integration = rbacExpress(rbac)
  const portal = integration.portal('admin', {
    getSubject: async req => {
      const id = req.header('x-user-id')
      return id ? { id } : null
    },
  })

  const app = express()
  app.use(integration.context())

  app.get('/posts', portal.requirePolicy('posts.read'), (_req, res) => {
    res.json([])
  })
  app.patch(
    '/posts/:id',
    portal.requirePolicy('posts.update', {
      resource: req => ({ type: 'post', id: req.params.id }),
    }),
    (_req, res) => {
      res.json({ ok: true })
    },
  )

  app.use(integration.errorHandler())

  const server: Server = app.listen(0)
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { server, baseUrl: `http://127.0.0.1:${port}`, rbac, portal }
}

let ctx: Awaited<ReturnType<typeof makeApp>>

beforeEach(async () => {
  ctx = await makeApp()
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    ctx.server.close(err => (err ? reject(err) : resolve())),
  )
  ctx.rbac.dispose()
})

test('deny → exact body, then allow after granting', async () => {
  const denied = await fetch(`${ctx.baseUrl}/posts`, { headers: { 'x-user-id': 'u1' } })
  expect(denied.status).toBe(403)
  expect(await denied.json()).toEqual({ message: 'Forbidden', code: 'RBAC_POLICY_DENIED' })

  await ctx.portal.assignPolicy('u1', 'posts.read')
  const allowed = await fetch(`${ctx.baseUrl}/posts`, { headers: { 'x-user-id': 'u1' } })
  expect(allowed.status).toBe(200)
})

test('owned scope: non-owner gets RBAC_SCOPE_DENIED', async () => {
  await ctx.portal.assignPolicy('u2', 'posts.update', { scope: 'owned' })
  await ctx.rbac.ownership.record('u1', { type: 'post', id: 'p1' })

  const res = await fetch(`${ctx.baseUrl}/posts/p1`, {
    method: 'PATCH',
    headers: { 'x-user-id': 'u2' },
  })
  expect(res.status).toBe(403)
  expect(await res.json()).toEqual({ message: 'Forbidden', code: 'RBAC_SCOPE_DENIED' })
})
```

:::

With Express's `errorHandler()` the body is exactly `{ "message": "Forbidden", "code": "RBAC_POLICY_DENIED" }`, so `toEqual` works. Fastify's default error serializer wraps the same error with `statusCode` and `error` fields alongside `message` and `code` — assert with `toMatchObject` there.

### Seeding groups

`rbac.seedGroups()` takes the same shape your production `groups.ts` exports. Policy names are unqualified; the portal argument qualifies them:

```ts
await ctx.rbac.seedGroups(
  {
    editor: {
      label: 'Editor',
      policies: { 'posts.read': null, 'posts.update': 'owned' }, // null = unrestricted
    },
  },
  undefined,
  'admin',
)
await ctx.portal.assignGroup('u1', 'editor')
```

::: warning Sync before you seed
`assignPolicy` throws `UnknownPolicyError` when the policy does not exist in storage:

```
[rbac] Policy "admin.posts.read" not found — run `rbac sync` first.
```

The memory adapter enforces this deliberately (it is clause S12 of the storage contract), so a test that forgets `await rbac.sync(resources, 'admin')` fails exactly the way a production deploy that skipped `rbac sync` would. Keep the sync call in your factory, and pass the same portal name your guards use: grants are matched by strict equality on portal and context, so a grant seeded under the wrong portal is invisible to the guard rather than an error.
:::

## Resetting state between tests

Nothing is shared unless you share it:

- **Adapter** — `memoryAdapter()` holds all state in closures. A new adapter per test is an empty database; there is no reset API because you never need one.
- **Cache** — the factory above passes `cache: false` so a grant you remove mid-test cannot keep authorizing from a 30-second-TTL cache entry. (Alternatively keep the cache and call `await rbac.cache.clear()` after mutating grants outside the library, but disabling it removes the whole class of surprise.)
- **Engine** — call `rbac.dispose()` in teardown. It detaches the engine's invalidation-bus subscription so engines do not accumulate across a large suite.

## Verifying a custom storage adapter

If you wrote your own storage adapter, run the contract suite against it. The suite is the executable specification of the storage contract (clauses S1–S20): an adapter is conforming exactly when it passes.

```ts
// tests/my-adapter.contract.test.ts
import { describe, expect, it } from 'vitest'
import { runStorageAdapterContractSuite } from '@kyrobit/rbac/testing'
import { myAdapter } from '../src/my-adapter.js'

runStorageAdapterContractSuite({
  name: 'my-adapter',
  makeAdapter: async () => {
    const adapter = myAdapter(/* a fresh, isolated backing store */)
    return { adapter, cleanup: async () => { /* drop tables / close connections */ } }
  },
  test: { describe, it, expect },
})
```

The suite is runner-injected — pass `{ describe, it, expect }` from `vitest` or `bun:test`. `makeAdapter` is called once per test case and must return an isolated store each time; cases never share state. `cleanup` is optional and falls back to `adapter.close?.()`.

## Verifying a custom framework integration

`runFrameworkContractSuite` is the equivalent black-box HTTP contract for framework integrations: it checks portals, guard behavior, the error strategy (typed errors through the framework's own pipeline), per-request subject memoization and cache invalidation. You supply `makeApp(rbac, routes)`, which turns a `RouteSpec[]` into a running `TestApp`; the harness protocol (header-based test auth, required response headers) is documented on the suite's types in `@kyrobit/rbac/testing`.

```ts
import { describe, expect, it } from 'vitest'
import { runFrameworkContractSuite } from '@kyrobit/rbac/testing'
import { buildTestApp } from './helpers/build-test-app.js'

runFrameworkContractSuite({
  name: 'my-framework',
  makeApp: (rbac, routes) => buildTestApp(rbac, routes),
  test: { describe, it, expect },
})
```

## Next steps

- [Caching](/guide/caching) — why `cache: false` is the default recommendation for tests
- [Observing decisions](/guide/observability) — assert on `onDecision` events for engine-level unit tests
- [Tracking ownership](/guide/tracking-ownership) — the `rbac.ownership` API used to seed owned-scope tests
