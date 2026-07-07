# Testing

`memoryAdapter()` is a complete storage backend that lives in memory. Tests run against it with no database, no migrations, no cleanup.

A full test file for a guarded route:

```ts
// grades.test.ts
import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { createRbac, Policy } from '@kyrobit/rbac'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { memoryAdapter } from '@kyrobit/rbac/testing'

const policies = [new Policy('grades.view')]
const groups = {
  teacher: { label: 'Teacher', policies: ['grades.view'] },
}

async function buildApp() {
  const rbac = createRbac({ adapter: memoryAdapter(), policies, groups })
  await rbac.sync() // loads the policies, seeds the groups

  const app = Fastify()
  await app.register(rbacFastify(rbac))

  const teachers = app.rbac.domain({
    getSubject: req =>
      req.headers['x-user'] ? { id: String(req.headers['x-user']) } : null,
  })

  app.get('/grades', { preHandler: teachers.requirePolicy('grades.view') }, async () => [])
  return { app, teachers }
}

describe('GET /grades', () => {
  it('denies a user without the policy', async () => {
    const { app } = await buildApp()
    const res = await app.inject({ url: '/grades', headers: { 'x-user': 'u1' } })
    expect(res.statusCode).toBe(403)
  })

  it('allows a newly hired teacher', async () => {
    const { app, teachers } = await buildApp()
    await teachers.assignGroup('u1', 'teacher')
    const res = await app.inject({ url: '/grades', headers: { 'x-user': 'u1' } })
    expect(res.statusCode).toBe(200)
  })
})
```

Each test builds a fresh app and a fresh adapter. Grants never leak between tests. `bun:test` works the same way — only the first import changes.

In tests, `getSubject` reads the user from a header. Your real resolver stays in production code and out of the way.

## Seeding grants in tests

Assign through the domain, exactly like production code:

```ts
await teachers.assignGroup('u1', 'teacher')
await teachers.assignPolicy('u1', 'grades.update', { scope: 'owned' })
```

`rbac.sync()` must run first. It loads the policies and seeds the groups you gave `createRbac`. See [Assigning access](/guide/assigning-access).

## Testing your own adapter

If you wrote a storage adapter, run the contract suite instead of writing your own tests — see [Custom adapters](/guide/custom-adapters#implement-it-then-prove-it).
