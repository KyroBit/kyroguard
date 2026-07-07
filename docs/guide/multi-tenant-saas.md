# Building a multi-tenant SaaS

You run the platform. Every school is a customer. Each school brings teachers, students, and parents — three audiences, plus your own back office. This page puts the whole system together. Each piece is taught on its own page; here they only meet.

| In your product | In @kyrobit/rbac |
|---|---|
| The platform back office | The `admin` domain — grants with no tenant are platform-wide |
| Each school | A tenant. Tenants are data, not config — unbounded, nothing to register |
| Teachers, students, parents | One domain each: own app face, own policy names, own `getSubject` |
| The principal | The owner — `is_super`, computed per request, powerful only in their school |
| A teacher at two schools | Two assignments, one per tenant |

## Four domains, one createRbac

```ts
// rbac.config.ts
import { defineConfig } from '@kyrobit/rbac'

export default defineConfig({
  adapter: () => import('./src/db.js').then(m => m.adapter),
  domains: [
    { name: 'teachers', policies: './src/rbac/teachers/policies.ts', groups: './src/rbac/teachers/groups.ts' },
    { name: 'students', policies: './src/rbac/students/policies.ts', groups: './src/rbac/students/groups.ts' },
    { name: 'parents',  policies: './src/rbac/parents/policies.ts',  groups: './src/rbac/parents/groups.ts' },
    { name: 'admin',    policies: './src/rbac/admin/policies.ts',    groups: './src/rbac/admin/groups.ts' },
  ],
})
```

The files stay small. Teachers get the grade policies: `grades.view`, `grades.enter`, `grades.update`. Students get `grades.view`. Parents get `grades.view` and `attendance.view`. Admin gets `schools.manage` and `reports.view`. Same short names, four namespaces — the domain prefixes them apart. Domains and tenants are taught in [Multi-tenancy](/guide/multi-tenancy).

## Wiring the audiences

Each domain resolves its own users. Here are two of the four:

```ts
// app.ts
const teachers = app.rbac.domain('teachers', {
  getSubject: async req => {
    const t = await verifyTeacherSession(req)
    return t ? { id: t.id, tenant_id: t.schoolId } : null
  },
})

const parents = app.rbac.domain('parents', {
  getSubject: async req => {
    const p = await verifyParentSession(req)
    return p ? { id: p.id, tenant_id: p.schoolId } : null
  },
})

app.get('/grades', { preHandler: teachers.requirePolicy('grades.view') }, listGrades)

app.get('/portal/grades', { preHandler: parents.requirePolicy('grades.view') }, listChildGrades)
```

The guards check `teachers.grades.view` and `parents.grades.view` — different policies. `tenant_id` pins every request to one school. `students` and `admin` wire up the same way. Setup details: [Fastify](/guide/fastify).

## The platform side

Platform staff belong to no school. Their `getSubject` sets no `tenant_id`:

```ts
const admin = app.rbac.domain('admin', {
  getSubject: async req => {
    const staff = await verifyStaffSession(req)
    return staff ? { id: staff.id, is_super: staff.role === 'platform_admin' } : null
  },
})

await admin.assignGroup(analyst.id, 'reporting')
```

Matching is exact, and that is the trick. A grant with no `tenantId` matches requests that carry no tenant — exactly where admin requests live. So plain admin grants are platform-wide by construction.

`is_super` here marks your own operators: they pass every admin check. A support engineer who needs eyes inside one school gets an ordinary per-tenant assignment — `teachers.assignGroup(engineer.id, 'coordinator', { tenantId: 'school-42' })`. Inside each school, the per-request bypass belongs to the principal instead — that story is [Owners](/guide/owners).

## A parent sees only their child

The relationship rule, and no built-in fits. Not `owned` — the parent never created the grade. Not `in-tenant` — that is every grade in the school. Not `granted` — nobody shares grades row by row. The rule lives in your `parent_children` table. Write a scope on it, both halves — the check for single rows, the filter for lists:

```ts
// parents/scopes.ts
import { Scope } from '@kyrobit/rbac'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db.js'
import { grades, parentChildren } from '../db/schema.js'

const childIdsOf = async (parentId: string) => {
  const rows = await db.select({ id: parentChildren.childId })
    .from(parentChildren).where(eq(parentChildren.parentId, parentId))
  return rows.map(r => r.id)
}

export const ownChild = new Scope(
  'own-child',
  'Own child',
  async (parent, grade) => {
    if (!grade) return false // row rule: no row, no pass
    const [row] = await db.select().from(grades).where(eq(grades.id, grade.id))
    if (!row) return false
    return (await childIdsOf(parent.id)).includes(row.studentId)
  },
  async parent => {
    const ids = await childIdsOf(parent.id)
    return ids.length ? { where: inArray(grades.studentId, ids) } : false
  },
)
```

Students seeing their own grades is the same shape, smaller:

```ts
export const ownGrades = new Scope('own-grades', 'Own grades',
  async (student, grade) =>
    !!grade && (await db.select().from(grades).where(eq(grades.id, grade.id)))[0]?.studentId === student.id,
  student => ({ where: eq(grades.studentId, student.id) }))
```

Declare each in its policy's `scopeOptions`, then grant it in the group:

```ts
// parents/groups.ts
parent: { label: 'Parent', policies: { 'grades.view': 'own-child', 'attendance.view': 'own-child' } },
// students/groups.ts
student: { label: 'Student', policies: { 'grades.view': 'own-grades' } },
```

How scopes work — both halves, failing closed, keeping them honest — is [Scopes](/guide/scopes).

## Onboarding a school

Day zero for a new customer, in order:

1. Create the school row. Its id is the tenant — nothing to register.
2. Set its principal in your users table. Ownership is your data.
3. The principal signs in. `is_super` computes true; every check in their school passes ([Owners](/guide/owners)).
4. The principal hires staff: `teachers.assignGroup(user.id, 'teacher', { tenantId: school.id })` ([Assigning access](/guide/assigning-access)).

## Limits to know

There is one tenant level. Tenants never nest. A district above schools is modeled in your app: give district staff one assignment per school, or compute `is_super` across the schools they run. And relationship scopes ride on your own tables — the library never learns your family tree.

## Next steps

- [Multi-tenancy](/guide/multi-tenancy) — domains and tenants, taught properly.
- [Scopes](/guide/scopes) — the check and filter halves in depth.
- [Owners and superusers](/guide/owners) — the principal's bypass in full.
- [Production](/guide/production) — caching, audit, multiple servers.
