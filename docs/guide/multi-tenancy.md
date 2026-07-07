# Multi-tenancy

Domains split one backend into named apps, like `admin` and `teachers`. Tenants split access by school — `school-1`, `school-2`. Both match exactly, and that is what keeps access contained.

## Domains

One school group, two apps. `admin` is the school-office app. `teachers` is the teacher portal:

```ts
const admin = app.rbac.domain('admin', {
  getSubject: req => getOfficeSession(req),
})

const teachers = app.rbac.domain('teachers', {
  getSubject: req => getTeacherSession(req),
})

app.get('/reports',
  { preHandler: admin.requirePolicy('reports.view') },
  listReports)

app.get('/grades',
  { preHandler: teachers.requirePolicy('grades.view') },
  listGrades)
```

Office staff sign in through `admin`. Teachers sign in through `teachers`. Each domain resolves its own user, even on the same app.

A grant on one domain never works on another. Give someone `grades.view` on `teachers`, and the office routes still reject them.

Each domain also has its own policy names. `admin.requirePolicy('reports.view')` checks `admin.reports.view`. The `teachers` guard checks `teachers.grades.view`. They are different policies. Each domain gets its own policies file: `students.manage` and `reports.view` for the office, the grade policies for teachers. See [Policies](/guide/policies).

A single-app setup skips domains entirely. `app.rbac.domain({ getSubject })` takes no name, and policies stay unprefixed. Add domains when a second app shows up.

## Tenants

Each school is a tenant: `school-1`, `school-2`. Make Amina a coordinator in school-1, and that is the only school where she is one:

```ts
await teachers.assignGroup(amina.id, 'coordinator', { tenantId: 'school-1' })
```

Grants are exact. Amina is a coordinator in school-1. In school-2 she has no access at all.

On the request side, put the school on the user in `getSubject`:

```ts
const teachers = app.rbac.domain('teachers', {
  getSubject: async req => {
    const user = await getTeacherSession(req)
    return user ? { id: user.id, tenant_id: user.schoolId } : null
  },
})
```

`tenant_id` tells the guard which school the request belongs to. The guard only counts grants made for that school.

## Both together

```ts
app.get('/grades',
  { preHandler: teachers.requirePolicy('grades.view') },
  listGrades)
```

Amina requests `/grades` with `tenant_id: 'school-1'`. Allowed. The same request from school-2 gets a 403. Nothing about the route changed. Only the school did.

A school can also have an owner — the principal, who passes every check in that school ([Owners](/guide/owners)).

Rows carry the tenant too: the `in-tenant` scope limits a grant to the request's school ([Scopes](/guide/scopes#the-built-in-scopes)).

One thing to watch: omitting `tenantId` when assigning does not make a grant global. It makes a grant for requests that carry no school. To make Amina a coordinator in three schools, assign three times. Assignment details are in [Assigning access](/guide/assigning-access).

To see domains, tenants, owners, and scopes run one product together, read [Building a multi-tenant SaaS](/guide/multi-tenant-saas).
