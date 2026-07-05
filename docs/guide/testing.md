# Testing

`memoryAdapter()` is a complete storage backend that lives in memory. Tests run against it with no database, no migrations, no cleanup.

A full test file for a guarded route:

```ts
// sales.test.ts
import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { createRbac, Policy } from '@kyrobit/rbac'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { memoryAdapter } from '@kyrobit/rbac/testing'

const policies = [new Policy('sales.view')]
const groups = {
  cashier: { label: 'Cashier', policies: ['sales.view'] },
}

async function buildApp() {
  const rbac = createRbac({ adapter: memoryAdapter(), policies, groups })
  await rbac.sync() // loads the policies, seeds the groups

  const app = Fastify()
  await app.register(rbacFastify(rbac))

  const staff = app.rbac.domain({
    getSubject: req =>
      req.headers['x-user'] ? { id: String(req.headers['x-user']) } : null,
  })

  app.get('/sales', { preHandler: staff.requirePolicy('sales.view') }, async () => [])
  return { app, staff }
}

describe('GET /sales', () => {
  it('denies a user without the policy', async () => {
    const { app } = await buildApp()
    const res = await app.inject({ url: '/sales', headers: { 'x-user': 'u1' } })
    expect(res.statusCode).toBe(403)
  })

  it('allows a newly hired cashier', async () => {
    const { app, staff } = await buildApp()
    await staff.assignGroup('u1', 'cashier')
    const res = await app.inject({ url: '/sales', headers: { 'x-user': 'u1' } })
    expect(res.statusCode).toBe(200)
  })
})
```

Each test builds a fresh app and a fresh adapter. Grants never leak between tests. `bun:test` works the same way — only the first import changes.

In tests, `getSubject` reads the user from a header. Your real resolver stays in production code and out of the way.

## Seeding grants in tests

Assign through the domain, exactly like production code:

```ts
await staff.assignGroup('u1', 'cashier')
await staff.assignPolicy('u1', 'sales.void', { scope: 'owned' })
```

`rbac.sync()` must run first. It loads the policies and seeds the groups you gave `createRbac`. See [Assigning access](/guide/assigning-access).

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
