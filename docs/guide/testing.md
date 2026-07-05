# Testing

`memoryAdapter()` is a complete storage backend that lives in memory. Tests run against it with no database, no migrations, no cleanup.

A full test file for a guarded route:

```ts
// posts.test.ts
import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { createRbac, Policy } from '@kyrobit/rbac'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { memoryAdapter } from '@kyrobit/rbac/testing'

const resources = [{ type: 'post', policies: [new Policy('posts.read')] }]

async function buildApp() {
  const rbac = createRbac({ adapter: memoryAdapter(), resources })
  await rbac.sync(resources, 'admin') // 'admin' is the portal name

  const app = Fastify()
  await app.register(rbacFastify(rbac))

  const admin = app.rbac.portal('admin', {
    getSubject: req =>
      req.headers['x-user'] ? { id: String(req.headers['x-user']) } : null,
  })

  app.get('/posts', { preHandler: admin.requirePolicy('posts.read') }, async () => [])
  return { app, admin }
}

describe('GET /posts', () => {
  it('denies a user without the policy', async () => {
    const { app } = await buildApp()
    const res = await app.inject({ url: '/posts', headers: { 'x-user': 'u1' } })
    expect(res.statusCode).toBe(403)
  })

  it('allows a user with the policy', async () => {
    const { app, admin } = await buildApp()
    await admin.assignPolicy('u1', 'posts.read')
    const res = await app.inject({ url: '/posts', headers: { 'x-user': 'u1' } })
    expect(res.statusCode).toBe(200)
  })
})
```

Each test builds a fresh app and a fresh adapter. Grants never leak between tests. `bun:test` works the same way — only the first import changes.

In tests, `getSubject` reads the user from a header. Your real resolver stays in production code and out of the way.

## Seeding grants in tests

Assign through the portal, exactly like production code:

```ts
await admin.assignGroup('u1', 'editor')
await admin.assignPolicy('u1', 'posts.update', { scope: 'owned' })
```

Groups must be seeded first with `rbac.seedGroups()`, and policies synced with `rbac.sync()`. See [Assigning access](/guide/assigning-access).

## Testing your own adapter

If you wrote a storage adapter, do not write your own tests for it. Run the contract suite. It runs dozens of cases against your adapter. It passes exactly when the adapter behaves like the built-in ones:

```ts
import { describe, expect, it } from 'vitest'
import { runStorageAdapterContractSuite } from '@kyrobit/rbac/testing'
import { makeMyAdapter } from './my-adapter'

runStorageAdapterContractSuite({
  name: 'my-adapter',
  makeAdapter: async () => ({ adapter: await makeMyAdapter() }),
  test: { describe, it, expect },
})
```

See [Custom adapters](/guide/custom-adapters) for the interface itself.
