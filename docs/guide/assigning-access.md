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
await teachers.assignPolicy(user.id, 'grades.update', { scope: 'entered' })

// a promotion, valid in one school only
await teachers.assignGroup(user.id, 'coordinator', { tenantId: 'school-1' })
```

Policy names stay short — the domain adds its prefix ([Domains](/guide/domains)). Groups and policies must exist before you assign them. See [Groups](/guide/groups) and [Sync](/guide/sync).

Removal mirrors assignment. Someone leaves, you take the job title back:

```ts
await teachers.removeGroup(user.id, 'teacher', { tenantId: 'school-1' })
await teachers.removePolicy(user.id, 'grades.delete')
```

Assigning twice is safe. The second call does nothing.

Changes apply immediately on this server. Running several servers? See [Production](/guide/production).

## Scripts and seeders

A domain is a plain value you export once ([Domains](/guide/domains)), so a script imports it and calls the same methods a route would:

```ts
import { teachers } from './kyroguard/domains.js'

await teachers.assignGroup('user-42', 'teacher', { tenantId: 'school-1' })
await teachers.assignPolicy('user-42', 'grades.view', { tenantId: 'school-1' })
```

There is no second, lower-level assignment API. The domain supplies its own name, so a grant can never be filed under one domain while naming another's policy — a mistake that stores a grant nothing can ever use.

## Owners

Groups cover the staff. The principal is different — an owner passes every check in their own school without holding a single policy. That is `is_super`, and it has its own page: [Owners and superusers](/guide/owners).
