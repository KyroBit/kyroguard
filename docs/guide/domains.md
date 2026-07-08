# Domains

A domain is one named area of your app, with its own policies and its own idea of who the user is. One backend, several apps: `admin` is the school-office app, `teachers` is the teacher portal. Domains keep them apart — one guard instance never handles everything at once.

## Creating domains

`kyroguard init` scaffolds `src/kyroguard/domains.ts`: domains are plain values you export once and import next to any route.

```ts
// src/kyroguard/domains.ts
import { createGuard } from '@kyrobit/kyroguard'
import { createDomain } from '@kyrobit/kyroguard/fastify'
import { resources } from './policies.js'

export const guard = createGuard({ adapter, resources })

export const admin = createDomain(guard, 'admin', {
  getSubject: req => getOfficeSession(req),
})

export const teachers = createDomain(guard, 'teachers', {
  getSubject: req => getTeacherSession(req),
})
```

```ts
// routes/grades.ts
import { teachers } from '../kyroguard/domains.js'

app.get('/grades',
  { preHandler: teachers.requirePolicy('grades.view') },
  listGrades)
```

Office staff sign in through `admin`. Teachers sign in through `teachers`. Each domain resolves its own user, even on the same request pipeline. On Express, import `createDomain` from `@kyrobit/kyroguard/express` — everything else is identical.

A grant on one domain never works on another. Give someone `grades.view` on `teachers`, and the office routes still reject them.

## Policy names carry the domain

Each domain has its own policy names. `admin.requirePolicy('reports.view')` checks `admin.reports.view`. The `teachers` guard checks `teachers.grades.view`. They are different policies, from different policy files — one entry per domain in [`kyroguard.config.ts`](/reference/configuration):

```ts
domains: [
  { name: 'admin', policies: './src/kyroguard/admin/policies.ts' },
  { name: 'teachers', policies: './src/kyroguard/teachers/policies.ts' },
]
```

Write names without the prefix — domains add theirs for you. See [Policies](/guide/policies).

## Single-area apps

One app means no domains. Skip the name and policies stay unprefixed:

```ts
export const site = createDomain(guard, { getSubject })
```

Add domains when a second app shows up.

## Tenants

The second coordinate on every grant. A domain says *which app*; a tenant says *which customer* — here, which school. Put it on the user in `getSubject`:

```ts
export const teachers = createDomain(guard, 'teachers', {
  getSubject: async req => {
    const user = await getTeacherSession(req)
    return user ? { id: user.id, tenant_id: user.schoolId } : null
  },
})
```

Assign with the tenant, and the grant exists only there:

```ts
await teachers.assignGroup(amina.id, 'coordinator', { tenantId: 'school-1' })
```

Amina is a coordinator in school-1. The same request from school-2 gets a 403 — grants match domain and tenant exactly, in both directions. Omitting `tenantId` does not make a grant global; it makes a grant for requests that carry no tenant. To cover three schools, assign three times.

Rows carry the tenant too: the `in-tenant` scope limits a grant to the request's school ([Scopes](/guide/scopes#the-built-in-scopes)), and a tenant can have an owner who passes every check in it ([Owners](/guide/owners)).

To see domains, tenants, owners, and scopes run one product together, read [Building a multi-tenant SaaS](/guide/multi-tenant-saas).
