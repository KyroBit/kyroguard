# Express

Wire `@kyrobit/rbac` into Express 4 or 5. This is a complete setup:

```ts
// app.ts
import express from 'express'
import { createRbac } from '@kyrobit/rbac'
import { rbacExpress } from '@kyrobit/rbac/express'
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from './db/rbac-schema.js' // written by `rbac init`
import { db } from './db.js'
import { resources } from './resources.js'
import { verifySession } from './auth.js'

const rbac = createRbac({ adapter: drizzleAdapter(db, { schema }), resources })
const { context, domain, errorHandler } = rbacExpress(rbac)

const app = express()
app.use(context())

const teachers = domain({
  getSubject: async req => {
    const user = await verifySession(req.headers.authorization)
    return user ? { id: user.id } : null
  },
})

app.get('/grades', teachers.requirePolicy('grades.view'), (req, res) => {
  res.json([])
})

app.use(errorHandler())
app.listen(3000)
```

`context()` lets guards see the current request. `domain()` creates a domain. `requirePolicy` is plain middleware. `errorHandler()` renders denials as JSON.

::: warning Order matters
Register `context()` before any guard and `errorHandler()` after your routes. In the wrong order, guards fail with a 500 instead of denying properly.
:::

`resources` holds your policy definitions ([Policies](/guide/policies)). `getSubject` returns the logged-in user, or `null` ([Protecting routes](/guide/protecting-routes)). `teachers` is an unnamed domain — the single-app form; named domains are in [Multi-tenancy](/guide/multi-tenancy).

## Errors

A denied guard never writes the response itself. It passes the error to `errorHandler()`, which responds:

```json
{
  "message": "Forbidden",
  "code": "RBAC_POLICY_DENIED"
}
```

That is the 403 for a missing policy. The other outcomes are in [Protecting routes](/guide/protecting-routes#the-four-outcomes); every code is in [Errors](/reference/errors). Errors that are not from this library pass through to your own error handler untouched.

To change the response shape, pass `formatError`:

```ts
const { context, domain, errorHandler } = rbacExpress(rbac, {
  formatError: error => ({
    status: error.statusCode,
    body: { error: error.code },
  }),
})
```

## Routers

```ts
const grades = express.Router()
grades.get('/', teachers.requirePolicy('grades.view'), listGrades)
grades.post('/', teachers.requirePolicy('grades.enter'), enterGrade)
app.use('/grades', grades)
```

Guards are plain middleware, so they mount on any router. Keep `context()` and `errorHandler()` at the app level.

## subjectHook

```ts
const grades = express.Router()
grades.use(teachers.subjectHook())
grades.post('/', enterGrade)
app.use('/grades', grades)
```

`subjectHook()` resolves the user without guarding. You need it on unguarded routes that record ownership, so the library knows which teacher entered the row. See [Ownership](/guide/ownership). Mount it on specific routers, not app-wide.
