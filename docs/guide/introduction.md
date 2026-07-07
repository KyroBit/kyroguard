# Introduction

@kyrobit/rbac answers one question on every request: is this user allowed to do this?

The docs run one example: a school management system. RBAC governs teachers and office staff. Students never log in.

Here is the whole library in one file:

```ts
import Fastify from 'fastify'
import { createRbac, Policy } from '@kyrobit/rbac'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { memoryAdapter } from '@kyrobit/rbac/testing' // in-memory store, no database

// A policy is a named permission — one thing a user can do
const policies = [new Policy('grades.view')]

// A group is a job title
const groups = { teacher: { label: 'Teacher', policies: ['grades.view'] } }

// One rbac instance for the whole app
const rbac = createRbac({ adapter: memoryAdapter(), policies, groups })
await rbac.sync() // loads the policies and the groups

const app = Fastify()
await app.register(rbacFastify(rbac))

// A domain turns a request into a user
const teachers = app.rbac.domain({
  getSubject: async req => ({ id: req.headers['x-user-id'] as string }),
})

// Guard a route
app.get('/grades', { preHandler: teachers.requirePolicy('grades.view') }, async () => [])

// Hire someone: assign the teacher group
await teachers.assignGroup('user-1', 'teacher')
```

This file is a sketch, not a runnable app.

You define policies in code. You assign them to users in the database. Guards enforce them on routes. The [quick start](/guide/quick-start) turns this into a running server in five minutes.

## The pieces

Six words cover everything this library does.

- **Policy** — a named permission, like `grades.view`: one thing a user can do. See [Policies](/guide/policies).
- **Group** — a job title, like `teacher`: its policies, assigned as one. See [Groups](/guide/groups).
- **Domain** — the app users sign in to: `teachers` (the teacher portal) or `admin` (the school office). See [Multi-tenancy](/guide/multi-tenancy).
- **Tenant** — the school a grant applies to, like `school-1`. See [Multi-tenancy](/guide/multi-tenancy).
- **Scope** — a condition on a permission: a teacher updates only their own grades, only unpublished ones, only while grading is open. See [Scopes](/guide/scopes).
- **Subject** — the logged-in user, as this library sees it. See [Protecting routes](/guide/protecting-routes).

Every guarded request either runs your handler or is denied — [Protecting routes](/guide/protecting-routes) walks through each outcome.

## Next

- [Quick start](/guide/quick-start) — a running server in five minutes, no database.
- [Installation](/guide/installation) — wire up your real database and framework.
