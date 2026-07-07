# Quick start

A guarded API in five minutes. No database needed. The in-memory adapter holds everything.

The example: the grades API of a school.

## 1. Install

```sh
mkdir rbac-demo && cd rbac-demo
npm init -y && npm pkg set type=module
npm install @kyrobit/kyroguard fastify
```

## 2. Create the server

Paste this into `server.ts`:

```ts
import Fastify from 'fastify'
import { createKyroguard, Policy } from '@kyrobit/kyroguard'
import { kyroguardFastify } from '@kyrobit/kyroguard/fastify'
import { memoryAdapter } from '@kyrobit/kyroguard/testing'

// What teachers can do
const policies = [new Policy('grades.view'), new Policy('grades.enter')]

// One job title
const groups = {
  teacher: { label: 'Teacher', policies: ['grades.view', 'grades.enter'] },
}

const guard = createKyroguard({ adapter: memoryAdapter(), policies, groups })

// Loads policies + groups — with a real database you run: npx kyroguard sync
await guard.sync()

const app = Fastify()
await app.register(kyroguardFastify(guard))

// Demo auth: the user id comes from a header
const teachers = app.kyroguard.domain({
  getSubject: async req => {
    const id = req.headers['x-user-id']
    return typeof id === 'string' ? { id } : null
  },
})

// The gradebook screen: teachers need grades.view
app.get('/grades', { preHandler: teachers.requirePolicy('grades.view') }, async () => [
  { id: 'grade-1', student: 'Sara', subject: 'Math', score: 87 },
])

// Hiring endpoint (unguarded, for the demo)
app.post('/hire/:userId', async req => {
  const { userId } = req.params as { userId: string }
  await teachers.assignGroup(userId, 'teacher')
  return { userId, group: 'teacher' }
})

await app.listen({ port: 3000 })
console.log('listening on http://localhost:3000')
```

In a real project the definitions live in files and `npx kyroguard sync` loads them ([Sync](/guide/sync)).

Run it. `npx` downloads `tsx` on first use:

```sh
npx tsx server.ts
```

## 3. Get denied

No user on the request:

```sh
curl -i localhost:3000/grades
```

```
HTTP/1.1 401 Unauthorized
{"statusCode":401,"code":"UNAUTHENTICATED","error":"Unauthorized","message":"Unauthorized"}
```

Someone not hired yet:

```sh
curl -i localhost:3000/grades -H 'x-user-id: u1'
```

```
HTTP/1.1 403 Forbidden
{"statusCode":403,"code":"ACCESS_DENIED","error":"Forbidden","message":"Forbidden"}
```

## 4. Hire them

```sh
curl -X POST localhost:3000/hire/u1
```

```
{"userId":"u1","group":"teacher"}
```

## 5. Get allowed

```sh
curl localhost:3000/grades -H 'x-user-id: u1'
```

```
[{"id":"grade-1","student":"Sara","subject":"Math","score":87}]
```

That is the whole loop. Define policies, guard routes, hire teachers into groups. The grant took effect on the next request. No restart, no token refresh.

## Next

The in-memory adapter forgets everything on restart. Use your real database: [Installation](/guide/installation).
