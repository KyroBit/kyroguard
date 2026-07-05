# Fastify

Wire `@kyrobit/rbac` into Fastify 5. This is a complete setup:

```ts
// app.ts
import Fastify from 'fastify'
import { createRbac } from '@kyrobit/rbac'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from './db/rbac-schema.js' // written by `rbac init`
import { db } from './db.js'
import { resources } from './resources.js'
import { verifySession } from './auth.js'

const rbac = createRbac({ adapter: drizzleAdapter(db, { schema }), resources })

const app = Fastify()
await app.register(rbacFastify(rbac))

const staff = app.rbac.domain({
  getSubject: async req => {
    const user = await verifySession(req.headers.authorization)
    return user ? { id: user.id } : null
  },
})

app.get('/sales', { preHandler: staff.requirePolicy('sales.view') }, async () => {
  return []
})

await app.listen({ port: 3000 })
```

Three steps. Register `rbacFastify(rbac)` once. Create a domain with `app.rbac.domain()`. Guard routes with `requirePolicy` in `preHandler`.

`resources` holds your policy definitions. See [Policies](/guide/policies). The adapter connects your database. Swap in [Prisma](/databases/prisma) or [MongoDB](/databases/mongodb) the same way. `getSubject` returns the logged-in user, or `null`. See [Protecting routes](/guide/protecting-routes).

`staff` is a domain with no name — the single-app form. Named domains like `admin` and `branch` are covered in [Multi-tenancy](/guide/multi-tenancy).

## Errors

Guards throw. Fastify turns the thrown error into a JSON response. Your error handler and hooks still run. A user without the policy gets this 403:

```json
{
  "statusCode": 403,
  "code": "RBAC_POLICY_DENIED",
  "error": "Forbidden",
  "message": "Forbidden"
}
```

No logged-in user gets a 401 with code `RBAC_UNAUTHENTICATED`. Every code is listed in [Errors](/reference/errors).

Because guards throw, `setErrorHandler` sees the error like any other. `error instanceof PolicyDeniedError` works there. Import `PolicyDeniedError` from `@kyrobit/rbac`.

## formatError

```ts
await app.register(rbacFastify(rbac, {
  formatError: error => ({
    status: error.statusCode,
    body: { error: error.code },
  }),
}))
```

`formatError` replaces the response for denials. It only sees rbac errors. Everything else keeps flowing through Fastify's own error pipeline.

## subjectHook

```ts
app.register(async scope => {
  scope.addHook('preHandler', staff.subjectHook())
  scope.post('/sales', createSale)
})
```

`subjectHook()` resolves the user without guarding. You need it on unguarded routes that record ownership, so the library knows which cashier created the row. See [Ownership](/guide/ownership). Register it inside a scoped plugin, not app-wide.
