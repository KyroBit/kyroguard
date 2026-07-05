# Quick start

A guarded API in five minutes. No database needed. The in-memory adapter holds everything.

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

// Two policies on one resource
const resources = [
  { type: 'post', policies: [new Policy('posts.read'), new Policy('posts.write')] },
]

const rbac = createRbac({ adapter: memoryAdapter(), resources })

// Load the policies and one group into the in-memory store
await rbac.sync(resources, 'app')
await rbac.seedGroups(
  { editor: { label: 'Editor', policies: ['posts.read', 'posts.write'] } },
  undefined, // optional second argument, not needed here
  'app',     // the portal name
)

const app = Fastify()
await app.register(rbacFastify(rbac))

// Demo auth: the user id comes from a header
const portal = app.rbac.portal('app', {
  getSubject: async req => {
    const id = req.headers['x-user-id']
    return typeof id === 'string' ? { id } : null
  },
})

// The guarded route
app.get('/posts', { preHandler: portal.requirePolicy('posts.read') }, async () => [
  { id: '1', title: 'Hello' },
])

// Assignment endpoint (unguarded, for the demo)
app.post('/make-editor/:userId', async req => {
  const { userId } = req.params as { userId: string }
  await portal.assignGroup(userId, 'editor')
  return { userId, group: 'editor' }
})

await app.listen({ port: 3000 })
console.log('listening on http://localhost:3000')
```

Run it. `npx` downloads `tsx` on first use:

```sh
npx tsx server.ts
```

## 3. Get denied

No user on the request:

```sh
curl -i localhost:3000/posts
```

```
HTTP/1.1 401 Unauthorized
{"statusCode":401,"code":"RBAC_UNAUTHENTICATED","error":"Unauthorized","message":"Unauthorized"}
```

A user without the policy:

```sh
curl -i localhost:3000/posts -H 'x-user-id: u1'
```

```
HTTP/1.1 403 Forbidden
{"statusCode":403,"code":"RBAC_POLICY_DENIED","error":"Forbidden","message":"Forbidden"}
```

## 4. Assign the group

```sh
curl -X POST localhost:3000/make-editor/u1
```

```
{"userId":"u1","group":"editor"}
```

## 5. Get allowed

```sh
curl localhost:3000/posts -H 'x-user-id: u1'
```

```
[{"id":"1","title":"Hello"}]
```

That is the whole loop. Define policies, guard routes, assign groups. The grant took effect on the next request. No restart, no token refresh.

## Next

The in-memory adapter forgets everything on restart. Use your real database: [Installation](/guide/installation).
