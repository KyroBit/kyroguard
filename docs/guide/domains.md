# Domains

A domain is one named area of your app, with its own policies and its own idea of who the user is. One backend, several apps: `admin` is the school-office app, `teachers` is the teacher portal. Domains keep them apart — one guard instance never handles everything at once.

## Creating domains

`kyroguard init` scaffolds `src/kyroguard/domains.ts`: domains are plain values you export once and import next to any route.

```ts
// src/kyroguard/domains.ts
import { createGuard } from '@kyrobit/kyroguard'
import { createDomain } from '@kyrobit/kyroguard/fastify'
import { resources as adminResources } from './policies/admin.js'
import { resources as teacherResources } from './policies/teachers.js'

export const guard = createGuard({ adapter })

export const admin = createDomain(guard, 'admin', {
  resources: adminResources,
  getSubject: req => getOfficeSession(req),
})

export const teachers = createDomain(guard, 'teachers', {
  resources: teacherResources,
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

Each domain has its own policy names. `admin.requirePolicy('reports.view')` checks `admin.reports.view`. The `teachers` guard checks `teachers.grades.view`. They are different policies, from different policy files — the file name is the domain. Point [`kyroguard.config.ts`](/reference/configuration) at the directory once:

```ts
domains: './src/kyroguard'
```

Write names without the prefix — domains add theirs for you. See [Policies](/guide/policies).

## One file per domain

Policies stay in one auditable place — the kyroguard directory. One file per domain; adding a domain is adding a file, with no config change:

```
src/kyroguard/
├── domains.ts        # guard + domains — one module, like your db client
├── policies/
│   ├── admin.ts      # domain 'admin'
│   └── teachers.ts   # domain 'teachers'
└── groups/
    ├── admin.ts      # picked up automatically
    └── teachers.ts
```

`kyroguard sync` derives the domains from the file names, and at runtime each domain carries its own file — nothing is unioned by hand anywhere.

Route modules never define policies — they import their domain and guard their routes:

```ts
// src/modules/blog/routes.ts
import { admin } from '../../kyroguard/domains.js'

app.get('/blogs', { preHandler: admin.requirePolicy('blog.read') }, listBlogs)
```

`domains.ts` stays the one shared module on purpose — the guard and its domains are process-wide singletons, exactly like your database client.

## Single-area apps

One app means no domains. Skip the name and policies stay unprefixed:

```ts
import { resources } from './policies.js'

export const site = createDomain(guard, { resources, getSubject })
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
