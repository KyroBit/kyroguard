# Introduction

@kyrobit/rbac answers one question on every request: is this user allowed to do this?

Here is the whole library in one file:

```ts
import Fastify from 'fastify'
import { createRbac, Policy } from '@kyrobit/rbac'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { memoryAdapter } from '@kyrobit/rbac/testing' // in-memory store, no database

// A policy is a named permission
const resources = [{ type: 'post', policies: [new Policy('posts.read')] }]

// One rbac instance for the whole app
const rbac = createRbac({ adapter: memoryAdapter(), resources })

const app = Fastify()
await app.register(rbacFastify(rbac))

// A portal turns a request into a user
const portal = app.rbac.portal('app', {
  getSubject: async req => ({ id: req.headers['x-user-id'] as string }),
})

// Guard a route
app.get('/posts', { preHandler: portal.requirePolicy('posts.read') }, async () => [])

// Groups are roles — assign one (the quick start seeds 'editor' first)
await portal.assignGroup('user-1', 'editor')
```

This file is a sketch, not a runnable app.

You define policies in code. You assign them to users in the database. Guards enforce them on routes. The [quick start](/guide/quick-start) turns this into a running server in five minutes.

## The pieces

Six words cover everything this library does.

- **Policy** — a named permission, like `posts.read`. See [Policies](/guide/policies).
- **Group** — a role: a named set of policies you assign as one. See [Groups](/guide/groups).
- **Portal** — a named area of your app, like `admin` or `customer`. See [Portals](/guide/portals).
- **Context** — a tenant split inside a portal, like a branch or workspace. See [Portals](/guide/portals).
- **Scope** — a row-level limit, like "only posts they own". See [Scopes](/guide/scopes).
- **Subject** — the logged-in user, as this library sees it. See [Protecting routes](/guide/protecting-routes).

## How a request flows

1. A request hits a guarded route.
2. The guard calls your `getSubject` to resolve the user. No user means 401.
3. The engine looks up the user's policies. Missing policy means 403.
4. If the policy is scoped, the scope checks the target row. A failed check means 403.
5. Your handler runs.

## Next

- [Quick start](/guide/quick-start) — a running server in five minutes, no database.
- [Installation](/guide/installation) — wire up your real database and framework.
