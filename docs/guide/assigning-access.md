# Assigning access

Hiring a teacher for school-1 is one call:

```ts
await teachers.assignGroup(user.id, 'teacher', { tenantId: 'school-1' })
```

This makes the user a teacher in school-1, on the `teachers` domain. Most apps only need `assignGroup` and `assignPolicy` on a domain.

```ts
// a single policy instead of a job title
await teachers.assignPolicy(user.id, 'grades.delete')

// scoped: only grades the user entered
await teachers.assignPolicy(user.id, 'grades.update', { scope: 'owned' })

// a promotion, valid in one school only
await teachers.assignGroup(user.id, 'coordinator', { tenantId: 'school-1' })
```

Policy names stay short — the domain adds its prefix ([Multi-tenancy](/guide/multi-tenancy)). Groups and policies must exist before you assign them. See [Groups](/guide/groups) and [Sync](/guide/sync).

Removal mirrors assignment. Someone leaves, you take the job title back:

```ts
await teachers.removeGroup(user.id, 'teacher', { tenantId: 'school-1' })
await teachers.removePolicy(user.id, 'grades.delete')
```

Assigning twice is safe. The second call does nothing.

Changes apply immediately on this server. Running several servers? See [Production](/guide/production).

## Scripts and admin panels

Outside a request handler there is often no domain instance. Use `guard.admin.*` there:

```ts
import { guard } from './rbac.js'

await guard.admin.assignGroup(
  { subjectId: 'user-42', domain: 'teachers', tenantId: 'school-1' },
  'teacher',
)

await guard.admin.assignPolicy(
  { subjectId: 'user-42', domain: 'teachers', tenantId: 'school-1' },
  'teachers.grades.view',
)
```

Same operations, made explicit. `guard.admin` takes full policy names like `teachers.grades.view`. Domain instances add the prefix for you. This API does not.

## Owners

Groups cover the staff. The principal is different — an owner passes every check in their own school without holding a single policy. That is `is_super`, and it has its own page: [Owners and superusers](/guide/owners).
