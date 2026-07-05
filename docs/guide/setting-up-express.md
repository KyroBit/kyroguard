# Setting up Express

You wire `@kyrobit/rbac` into an Express app with three pieces in a fixed order: `context()` first, portal guards on your routes, `errorHandler()` last. Both Express 4 and Express 5 are supported.

::: tip Prerequisites
You need a configured `Rbac` instance backed by a storage adapter, with the rbac tables migrated and your policies synced (`rbac sync`) — see [Installation](/guide/installation). The examples use the starter `post` resource from `src/rbac/policies.ts`.
:::

## 1. Open the request context first

```ts
import express from 'express'
import { rbacExpress } from '@kyrobit/rbac/express'
import { rbac } from './rbac/instance.js' // your createRbac(...) instance

const app = express()
const { context, portal, errorHandler } = rbacExpress(rbac)

app.use(context()) // before ANY portal guard
```

`context()` opens the per-request store that guards read and write: it is where each portal memoizes its resolved subject and where ownership tracking finds the current user. It must run before every guard, because a guard without the store cannot tell "no user" apart from "rbac not wired" — so it fails the request instead of guessing.

## 2. Create a portal and guard routes

```ts
const admin = portal('admin', {
  // Called lazily at guard time, memoized per request per portal.
  // Return null when the request has no authenticated user → 401.
  getSubject: async req => {
    const id = req.header('x-user-id') // demo only — see the note below
    return id ? { id } : null
  },
})

app.get('/posts/:id', admin.requirePolicy('posts.read'), (req, res) => {
  res.json({ id: req.params.id, title: 'Hello' })
})
```

Creating a portal touches no app-wide state — no `app.use`, no hook. Policy names are unqualified; the `admin` portal checks the stored grant `admin.posts.read`. Replace the header lookup with your real session or JWT resolution — see [Resolving the subject](/guide/resolving-the-subject).

## 3. Terminate with errorHandler() last

```ts
app.use(errorHandler()) // after all routes
```

Guards never write responses. On a denial they forward the typed error with `next(err)`, and `errorHandler()` renders it as JSON. A denied request produces exactly:

```json
{ "message": "Forbidden", "code": "RBAC_POLICY_DENIED" }
```

with status 403, and an unauthenticated one produces status 401 with:

```json
{ "message": "Unauthorized", "code": "RBAC_UNAUTHENTICATED" }
```

`errorHandler()` handles only `RbacError` instances (and only when headers have not been sent yet); every other error is passed to `next(error)` so your existing error middleware keeps working. The full status/code table is in [Protecting routes](/guide/protecting-routes).

::: warning Order is the contract
`context()` before guards, `errorHandler()` after routes. If a guard runs without `context()`, the request fails with status 500 and this body:

```json
{
  "message": "[rbac] No request context for portal \"admin\" — register rbacExpress(rbac).context() before its guards.",
  "code": "RBAC_MISCONFIGURED"
}
```

If you forget `errorHandler()` (and have no error middleware of your own), denials fall through to Express's default handler, which responds with `text/html` instead of the JSON bodies above.
:::

## 4. Put it together

A complete server file, using the Drizzle PostgreSQL adapter:

```ts
// src/server.ts
import express from 'express'
import { drizzle } from 'drizzle-orm/node-postgres'
import { createRbac } from '@kyrobit/rbac'
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from '@kyrobit/rbac/drizzle/schema/pg'
import { rbacExpress } from '@kyrobit/rbac/express'
import { resources } from './rbac/policies.js'

const db = drizzle(process.env.DATABASE_URL!)
const rbac = createRbac({ adapter: drizzleAdapter(db, { schema }), resources })

const app = express()
app.use(express.json())

const { context, portal, errorHandler } = rbacExpress(rbac)
app.use(context())

const admin = portal('admin', {
  getSubject: async req => {
    const id = req.header('x-user-id')
    return id ? { id } : null
  },
})

// Demo grant so the curl calls below work. Assignments are idempotent
// upserts; this requires `rbac sync` to have created the policy rows.
await admin.assignPolicy('u1', 'posts.read')

app.get('/posts/:id', admin.requirePolicy('posts.read'), (req, res) => {
  res.json({ id: req.params.id, title: 'Hello' })
})

app.use(errorHandler())

app.listen(3000)
```

Exercise all three outcomes:

```sh
curl -s localhost:3000/posts/1 -H 'x-user-id: u1'   # 200 — granted
curl -s localhost:3000/posts/1                      # 401 — no subject
curl -s localhost:3000/posts/1 -H 'x-user-id: u2'   # 403 — no grant
```

## Mounting routers

Guards are plain `RequestHandler`s, so they compose with routers as usual. An app-level `context()` covers every mounted router:

```ts
import { Router } from 'express'

const posts = Router()

posts.get('/:id', admin.requirePolicy('posts.read'), (req, res) => {
  res.json({ id: req.params.id })
})

posts.patch(
  '/:id',
  admin.requirePolicy('posts.update', {
    resource: req => ({ type: 'post', id: req.params.id }),
  }),
  (req, res) => {
    res.json({ updated: req.params.id })
  },
)

app.use('/posts', posts) // context() is already registered on the app
```

## Bringing your own error handler

You can skip `errorHandler()` and fold rbac denials into your existing terminal error middleware — check `instanceof RbacError`:

```ts
import { RbacError } from '@kyrobit/rbac'
import type { ErrorRequestHandler } from 'express'

const appErrors: ErrorRequestHandler = (error, req, res, next) => {
  if (error instanceof RbacError) {
    res.status(error.statusCode).json({ code: error.code, message: error.message })
    return
  }
  // ...your other error branches
  next(error)
}

app.use(appErrors)
```

To keep `errorHandler()` but change its body shape, pass `formatError` when creating the integration:

```ts
const { context, portal, errorHandler } = rbacExpress(rbac, {
  formatError: (error, req) => ({
    status: error.statusCode,
    body: { code: error.code, message: error.message, path: req.originalUrl },
  }),
})
```

## Express 4 and 5

The peer range is `^4.18.0 || ^5.0.0`. Express 4 does not forward rejected promises from async middleware to the error pipeline; rbac guards do not depend on that — every guard settles its async work internally and calls `next(err)` explicitly, so denials behave identically on both majors without wrappers like `express-async-errors`. (Your own async route handlers on Express 4 still need whatever handling they use today.)

## Next steps

- [Resolving the subject](/guide/resolving-the-subject) — the `getSubject` contract, subject shape, JWT and session wiring.
- [Protecting routes](/guide/protecting-routes) — the guard decision table and scoped grants.
- [Error reference](/reference/errors) — every `RBAC_*` code in one place.
