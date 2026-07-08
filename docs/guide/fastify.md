# Fastify

Wire `@kyrobit/kyroguard` into Fastify 5. This is a complete setup:

```ts
// app.ts
import Fastify from 'fastify'
import { createKyroguard } from '@kyrobit/kyroguard'
import { kyroguardFastify } from '@kyrobit/kyroguard/fastify'
import { drizzleAdapter } from '@kyrobit/kyroguard/drizzle'
import * as schema from './db/kyroguard-schema.js' // written by `kyroguard init`
import { db } from './db.js'
import { resources } from './resources.js'
import { verifySession } from './auth.js'

const guard = createKyroguard({ adapter: drizzleAdapter(db, { schema }), resources })

const app = Fastify()
await app.register(kyroguardFastify(guard))

const teachers = app.kyroguard.domain({
  getSubject: async req => {
    const user = await verifySession(req.headers.authorization)
    return user ? { id: user.id } : null
  },
})

app.get('/grades', { preHandler: teachers.requirePolicy('grades.view') }, async () => {
  return []
})

await app.listen({ port: 3000 })
```

Three steps. Register `kyroguardFastify(guard)` once. Create a domain with `app.kyroguard.domain()`. Guard routes with `requirePolicy` in `preHandler`.

`resources` holds your policy definitions ([Policies](/guide/policies)). The [Prisma](/databases/prisma) and [MongoDB](/databases/mongodb) adapters swap in the same way. `getSubject` returns the logged-in user, or `null` ([Protecting routes](/guide/protecting-routes)). `teachers` is an unnamed domain — the single-app form; named domains are in [Multi-tenancy](/guide/multi-tenancy).

## Errors

Guards throw. Fastify turns the thrown error into a JSON response. Your error handler and hooks still run. A user without the policy gets this 403:

```json
{
  "statusCode": 403,
  "code": "ACCESS_DENIED",
  "error": "Forbidden",
  "message": "Forbidden"
}
```

The other outcomes are in [Protecting routes](/guide/protecting-routes#the-four-outcomes); every code is in [Errors](/reference/errors). A failed scope check sends the same `ACCESS_DENIED` body — Fastify's default serializer does not carry the error's `reason` field, so use `formatError` (below) or `setErrorHandler` when clients need to tell the two denials apart.

Because guards throw, `setErrorHandler` sees the error like any other. `error instanceof PolicyDeniedError` works there. Import `PolicyDeniedError` from `@kyrobit/kyroguard`.

## formatError

```ts
await app.register(kyroguardFastify(guard, {
  formatError: error => ({
    status: error.statusCode,
    body: { error: error.code },
  }),
}))
```

`formatError` replaces the response for denials. It only sees kyroguard errors. Everything else keeps flowing through Fastify's own error pipeline.

## subjectHook

```ts
app.register(async scope => {
  scope.addHook('preHandler', teachers.subjectHook())
  scope.post('/grades', enterGrade)
})
```

`subjectHook()` resolves the user without guarding. You need it on unguarded routes that record ownership, so the library knows which teacher entered the row. See [Ownership](/guide/ownership). Register it inside a scoped plugin, not app-wide.
