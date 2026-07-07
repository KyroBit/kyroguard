# Building a multi-tenant SaaS

You built a school app. Now you want to sell it to many schools. Every school should feel the app is theirs alone — that is a multi-tenant SaaS, and this is its shape:

```
You (the platform)
├── Greenwood School
│   ├── office (hires teachers, enrolls students)
│   └── teachers · students · parents
└── Hillside School
    └── ...same...
```

This page follows one school — Greenwood — from signup to daily life. Every piece is taught in depth on its own page; here you watch them work together.

## 1. Greenwood signs up

A **tenant** is one customer's world — here, one school ([Multi-tenancy](/guide/multi-tenancy)). To the library a tenant is just an id you attach to grants and requests; there is nothing to register.

So onboarding Greenwood is one insert in your own database:

```ts
const [greenwood] = await db.insert(schools)
  .values({ name: 'Greenwood School' }).returning() // your table, your id
// greenwood.id is the tenant id — every Greenwood grant will carry it
```

## 2. Five front doors

Greenwood's people are not one crowd. A **domain** is one kind of user's app — teachers get one, parents get another; you get the admin one ([Multi-tenancy](/guide/multi-tenancy)).

This declares the five front doors, each with its own policies and groups:

```ts
// kyroguard.config.ts
import { defineConfig } from '@kyrobit/kyroguard'

export default defineConfig({
  adapter: () => import('./src/db.js').then(m => m.adapter),
  domains: [
    { name: 'teachers', policies: './src/rbac/teachers/policies.ts', groups: './src/rbac/teachers/groups.ts' }, // the teacher app
    { name: 'students', policies: './src/rbac/students/policies.ts', groups: './src/rbac/students/groups.ts' }, // the student app
    { name: 'parents',  policies: './src/rbac/parents/policies.ts',  groups: './src/rbac/parents/groups.ts' },  // the parent portal
    { name: 'school',   policies: './src/rbac/school/policies.ts',   groups: './src/rbac/school/groups.ts' },   // the school office
    { name: 'admin',    policies: './src/rbac/admin/policies.ts',    groups: './src/rbac/admin/groups.ts' },    // YOUR back office
  ],
})
```

Each domain turns its own requests into users. This one recognizes teachers, and the guard on the route checks their permission:

```ts
// app.ts
const teachers = app.rbac.domain('teachers', {
  getSubject: async req => {
    const t = await verifyTeacherSession(req)             // your auth, not the library's
    return t ? { id: t.id, tenant_id: t.schoolId } : null // tenant_id pins the request to one school
  },
})

app.get('/grades', { preHandler: teachers.requirePolicy('grades.view') }, listGrades)
```

`parents`, `students`, `school`, and `admin` wire up the same way, each with its own session check ([Fastify](/guide/fastify)).

## 3. The principal gets the keys

Day zero at Greenwood: the grants table is empty, and someone has to make the first hire. That someone is the principal — the **owner**, the person whose `is_super: true` passes every check in their domain ([Owners](/guide/owners)).

This makes the principal all-powerful — inside the office app, inside Greenwood only:

```ts
const school = app.rbac.domain('school', {
  getSubject: async req => {
    const s = await verifyOfficeSession(req)
    if (!s) return null
    return {
      id: s.id,
      tenant_id: s.schoolId,
      is_super: s.id === s.school.principalId, // the owner check — your data decides
    }
  },
})
```

## 4. The principal hires a registrar

The principal opens the office app and adds Ms. Riaz to the front office. That is one group assignment — a **group** is a job title ([Groups](/guide/groups)).

This gives Ms. Riaz the registrar job — at Greenwood, nowhere else:

```ts
await school.assignGroup(msRiaz.id, 'registrar', { tenantId: greenwood.id }) // tenantId: only this school
```

`registrar` lives in the `school` domain's groups file — say `{ 'staff.manage': 'all', 'students.enroll': 'all' }` ([Assigning access](/guide/assigning-access)).

## 5. The office hires a teacher

Ms. Riaz hires Greenwood's first teacher. Look at what is doing what: the HIRE button lives in the office app. The TEACHING permission lives in the teachers app. One button, two domains.

The guard checks the office's permission; the grant it writes lands in the teachers domain:

```ts
app.post('/staff/hire', { preHandler: school.requirePolicy('staff.manage') }, async req => {
  const staff = await verifyOfficeSession(req)                                    // who pressed the button
  const teacher = await createTeacherAccount(req.body)                            // your users table
  await teachers.assignGroup(teacher.id, 'teacher', { tenantId: staff.schoolId }) // grant lands in the OTHER domain
})
```

Domains separate audiences, not power — any server code holding the `teachers` domain object can write grants into it.

## 6. A parent logs in

A Greenwood parent should see exactly one thing: their own child's grades. No built-in rule fits. Not "rows I created" — the parent never created a grade. Not "rows in my school" — that is every grade at Greenwood. The rule is "rows about MY child", and it lives in your `parent_children` table. You write that rule once, as a **scope** — a condition on a permission ([Scopes](/guide/scopes)).

This is the "my child only" rule — a check half for one row, a filter half for lists:

```ts
// parents/scopes.ts
import { Scope } from '@kyrobit/kyroguard'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db.js'
import { grades, parentChildren } from '../db/schema.js'

const childIdsOf = async (parentId: string) => {
  const rows = await db.select({ id: parentChildren.childId })
    .from(parentChildren).where(eq(parentChildren.parentId, parentId)) // YOUR family-tree table
  return rows.map(r => r.id)
}

export const ownChild = new Scope(
  'own-child',
  'Own child',
  async (parent, grade) => {  // check: may this parent see THIS row?
    if (!grade) return false  // no row named — fail closed
    const [row] = await db.select().from(grades).where(eq(grades.id, grade.id))
    if (!row) return false
    return (await childIdsOf(parent.id)).includes(row.studentId)
  },
  async parent => {           // filter: which rows go in their lists?
    const ids = await childIdsOf(parent.id)
    return ids.length ? { where: inArray(grades.studentId, ids) } : false
  },
)
```

Declare `ownChild` in the policy's `scopeOptions`, then this line attaches the rule to every parent's grant:

```ts
// parents/groups.ts
parent: { label: 'Parent', policies: { 'grades.view': 'own-child', 'attendance.view': 'own-child' } },
```

## 7. Meanwhile at Hillside

Hillside School signed up last month, and nothing above touched it. Matching is exact: Ms. Riaz's grant says `registrar` at Greenwood, so a request carrying Hillside's tenant id finds nothing — nothing at Greenwood leaks to Hillside.

## Limits to know

There is one tenant level — tenants never nest, so a district above schools is modeled in your app: one assignment per school, or `is_super` computed across the schools they run. Relationship scopes ride on your own tables — the library never learns your family tree. Both are by design.

## The whole picture

| Who | Which app (domain) | What they can touch | Enforced by |
|---|---|---|---|
| You, the platform | `admin` | Every school | Grants with no `tenant_id` are platform-wide; `is_super` for your operators |
| The principal | `school` | Everything at Greenwood | `is_super` computed in `getSubject` ([Owners](/guide/owners)) |
| Ms. Riaz, registrar | `school` | Staff and enrollment at Greenwood | The `registrar` group, granted with Greenwood's `tenantId` |
| A teacher | `teachers` | Grades at Greenwood | The `teacher` group, granted with Greenwood's `tenantId` |
| A student | `students` | Their own grades | An own-grades scope on `grades.view`, same shape as `own-child` |
| A parent | `parents` | Their own child's grades | The `own-child` scope on `grades.view` |

## Next steps

- [Multi-tenancy](/guide/multi-tenancy) — domains and tenants, taught properly.
- [Owners and superusers](/guide/owners) — the principal's bypass in full.
- [Scopes](/guide/scopes) — the check and filter halves in depth.
