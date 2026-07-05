# Quick start

A guarded API in five minutes. No database needed. The in-memory adapter holds everything.

The example: the staff API of a hardware store.

## 1. Install

```sh
mkdir rbac-demo && cd rbac-demo
npm init -y && npm pkg set type=module
npm install @kyrobit/rbac fastify
```

## 2. Create the server

Paste this into `server.ts`:

```ts
import Fastify from 'fastify'
import { createRbac, Policy } from '@kyrobit/rbac'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { memoryAdapter } from '@kyrobit/rbac/testing'

// What staff can do
const policies = [new Policy('sales.view'), new Policy('sales.create')]

// One job title
const groups = {
  cashier: { label: 'Cashier', policies: ['sales.view', 'sales.create'] },
}

const rbac = createRbac({ adapter: memoryAdapter(), policies, groups })

// Loads policies + groups — with a real database you run: npx rbac sync
await rbac.sync()

const app = Fastify()
await app.register(rbacFastify(rbac))

// Demo auth: the staff id comes from a header
const staff = app.rbac.domain({
  getSubject: async req => {
    const id = req.headers['x-user-id']
    return typeof id === 'string' ? { id } : null
  },
})

// The register screen: staff need sales.view
app.get('/sales', { preHandler: staff.requirePolicy('sales.view') }, async () => [
  { id: 'sale-1', item: 'claw hammer', total: 12.5 },
])

// Hiring endpoint (unguarded, for the demo)
app.post('/hire/:userId', async req => {
  const { userId } = req.params as { userId: string }
  await staff.assignGroup(userId, 'cashier')
  return { userId, group: 'cashier' }
})

await app.listen({ port: 3000 })
console.log('listening on http://localhost:3000')
```

In a real project the policies and groups live in files. You write `src/rbac/policies.ts` and `src/rbac/groups.ts`, and `npx rbac sync` loads both. This file does the same thing in code.

Run it. `npx` downloads `tsx` on first use:

```sh
npx tsx server.ts
```

## 3. Get denied

No staff member on the request:

```sh
curl -i localhost:3000/sales
```

```
HTTP/1.1 401 Unauthorized
{"statusCode":401,"code":"RBAC_UNAUTHENTICATED","error":"Unauthorized","message":"Unauthorized"}
```

Someone not hired yet:

```sh
curl -i localhost:3000/sales -H 'x-user-id: u1'
```

```
HTTP/1.1 403 Forbidden
{"statusCode":403,"code":"RBAC_POLICY_DENIED","error":"Forbidden","message":"Forbidden"}
```

## 4. Hire them

```sh
curl -X POST localhost:3000/hire/u1
```

```
{"userId":"u1","group":"cashier"}
```

## 5. Get allowed

```sh
curl localhost:3000/sales -H 'x-user-id: u1'
```

```
[{"id":"sale-1","item":"claw hammer","total":12.5}]
```

That is the whole loop. Define policies, guard routes, hire staff into groups. The grant took effect on the next request. No restart, no token refresh.

## Next

The in-memory adapter forgets everything on restart. Use your real database: [Installation](/guide/installation).
