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

const staff = domain({
  getSubject: async req => {
    const user = await verifySession(req.headers.authorization)
    return user ? { id: user.id } : null
  },
})

app.get('/sales', staff.requirePolicy('sales.view'), (req, res) => {
  res.json([])
})

app.use(errorHandler())
app.listen(3000)
```

`context()` lets guards see the current request. `domain()` creates a domain. `requirePolicy` is plain middleware. `errorHandler()` renders denials as JSON.

::: warning Order matters
Register `context()` before any guard and `errorHandler()` after your routes. In the wrong order, guards fail with a 500 instead of denying properly.
:::

`resources` holds your policy definitions. See [Policies](/guide/policies). `getSubject` returns the logged-in user, or `null`. See [Protecting routes](/guide/protecting-routes).

`staff` is a domain with no name — the single-app form. Named domains like `admin` and `branch` are covered in [Multi-tenancy](/guide/multi-tenancy).

## Errors

A denied guard never writes the response itself. It passes the error to `errorHandler()`, which responds:

```json
{
  "message": "Forbidden",
  "code": "RBAC_POLICY_DENIED"
}
```

That is the 403 for a missing policy. No logged-in user gets a 401 with code `RBAC_UNAUTHENTICATED`. Every code is listed in [Errors](/reference/errors). Errors that are not from this library pass through to your own error handler untouched.

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
const sales = express.Router()
sales.get('/', staff.requirePolicy('sales.view'), listSales)
sales.post('/', staff.requirePolicy('sales.create'), createSale)
app.use('/sales', sales)
```

Guards are plain middleware, so they mount on any router. Keep `context()` and `errorHandler()` at the app level.
