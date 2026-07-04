# @kyrobit/rbac

Role-based access control for Fastify + Drizzle. Policy groups, resource ownership, multi-tenant context, and scope enforcement — with an ORM-agnostic adapter interface.

---

## Installation

```bash
bun add @kyrobit/rbac
```

Requires `drizzle-orm >= 0.30` and `fastify >= 5` as peer dependencies.

---

## Concepts

| Term | What it is |
|---|---|
| **Policy** | A named permission: `blog.publish`, `team.invite` |
| **Policy group** | A collection of policies assigned to users: `admin`, `member` |
| **Subject** | The authenticated user making a request |
| **Context** | The tenant/branch the request is operating in (optional) |
| **Scope** | A restriction on a policy: `own` means the user can only act on resources they created |
| **is_super** | A flag that bypasses all policy checks — emergency fallback only |

---

## Database setup

The package manages its own tables. Push them with drizzle-kit:

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: ['./src/db/schema/index.ts', './node_modules/@kyrobit/rbac/dist/schema.js'],
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

```bash
bun drizzle-kit push
```

Tables created: `rbac_policies`, `rbac_policy_groups`, `rbac_policy_group_policies`, `rbac_user_policy_groups`, `rbac_user_policies`, `rbac_resource_owners`.

---

## Defining policies

Create a `policies.ts` file that exports your policy definitions:

```ts
// src/rbac/policies.ts
import { Policy, type ResourceDefinition } from '@kyrobit/rbac'
import { blogs }  from '@/db/schema/blog.js'
import { issues } from '@/db/schema/issue.js'

export const blogPolicies = {
  read:    new Policy('blog.read',    'Read Blogs'),
  create:  new Policy('blog.create',  'Create Blog',  ['blog.read']),
  update:  new Policy('blog.update',  'Update Blog',  ['blog.read']),
  delete:  new Policy('blog.delete',  'Delete Blog',  ['blog.read']),
  publish: new Policy('blog.publish', 'Publish Blog', ['blog.read']),
}

export const issuePolicies = {
  read:    new Policy('issue.read',   'Read Issues'),
  update:  new Policy('issue.update', 'Update Issue', ['issue.read']),
  resolve: new Policy('issue.resolve','Resolve Issue',['issue.read']),
  delete:  new Policy('issue.delete', 'Delete Issue', ['issue.read']),
}

export const policies: ResourceDefinition[] = [
  { table: blogs,  type: 'blog',  policies: Object.values(blogPolicies) },
  { table: issues, type: 'issue', policies: Object.values(issuePolicies) },
]
```

**Naming convention:** `resource.action` — e.g. `blog.publish`, `team.invite`.

**`dependsOn`:** The second array in `new Policy(name, label, dependsOn)`. When a user is granted `blog.publish`, `blog.read` is automatically granted too. The `dependsOn` chain is resolved recursively.

---

## Syncing policies

Policies must be synced to the database whenever you add, rename, or remove them.

**CLI (recommended):**

```bash
bunx --bun rbac sync
```

Reads `rbac.config.ts` from your project root and `DATABASE_URL` from `.env` automatically.

```ts
// rbac.config.ts
export default {
  policies: './src/rbac/policies.ts',
}
```

**What sync does:**
- Upserts all policies (name is the identifier; label and dependsOn are updated)
- Removes orphaned policies that no longer exist in code — clears their assignments first
- Re-resolves `dependsOn` chains for all existing policy groups

**In the seeder** (so `bun run db:seed` works for new developers):

```ts
// src/db/seed.ts
import { execSync } from 'node:child_process'
execSync('bunx --bun rbac sync', { stdio: 'inherit' })
```

---

## Policy groups

Groups are collections of policies. Define system groups in code:

```ts
// src/rbac/groups.ts
export const systemGroups = [
  {
    name:     'admin',
    label:    'Admin',
    policies: 'all',   // every policy
  },
  {
    name:     'member',
    label:    'Member',
    policies: ['blog.read', 'issue.read'],  // resolved with dependsOn automatically
  },
]
```

Seed them:

```ts
// src/db/seeders/policy-groups.ts
import { systemGroups } from '@/rbac/groups.js'
// ... create groups and assign their policies from the DB
```

Custom groups (e.g. created by a user in an admin UI) can be created directly in `rbac_policy_groups` and have policies assigned via `rbac_policy_group_policies`.

---

## Registering the plugin

```ts
import { rbacPlugin, createDrizzleAdapter } from '@kyrobit/rbac'
import { db }       from '@/db/index.js'
import { policies } from '@/rbac/policies.js'

await app.register(rbacPlugin, {
  adapter: createDrizzleAdapter(db),
  db,                 // optional: enables the db proxy for scope injection on SELECT
  policies,

  getSubject: (req) => ({
    id:         req.authUser.id,
    is_super:   req.authUser.is_super === 'true',
    context_id: req.params.branchId ?? null,  // omit if single-tenant
  }),
})
```

---

## Protecting routes

```ts
// In a route handler
app.get('/blogs/:id/publish', {
  preHandler: [
    requireAuth,
    app.rbac.requirePolicy('blog.publish'),
  ],
}, handler)
```

### With scope enforcement

If the policy assignment has `scope = 'own'`, the user can only act on resources they created. Pass a `resource` function to enable the check:

```ts
app.rbac.requirePolicy('blog.publish', {
  resource: (req) => ({ type: 'blog', id: req.params.id }),
})
```

If the user's assignment has no scope restriction, the `resource` function is ignored and the check passes on the policy alone.

**How ownership is recorded:** Use the `rbac.db` proxy instead of the raw `db` for inserts, and ownership is tracked automatically:

```ts
// plugins/rbac.ts registers app.rbac.db
await app.rbac.db.insert(blogs).values({ title, content, author_id: req.authUser.id })
// ↑ automatically inserts into rbac_resource_owners
```

### Setting context per request

```ts
app.addHook('preHandler', async (req) => {
  app.rbac.setContext(req, 'admin')  // or 'branch', etc.
})
```

Context is used by the db proxy to determine which scope conditions apply to SELECT queries.

---

## Multi-tenant / multi-branch

Assign a user to a group within a specific context:

```ts
await db.insert(userPolicyGroups).values({
  subject_id:      userId,
  policy_group_id: ownerGroupId,
  context_id:      'branch-abc',   // scoped to this branch only
})

// Global assignment (applies in all contexts)
await db.insert(userPolicyGroups).values({
  subject_id:      userId,
  policy_group_id: adminGroupId,
  context_id:      null,
})
```

Pass `context_id` in `getSubject` from the request:

```ts
getSubject: (req) => ({
  id:         req.authUser.id,
  is_super:   req.authUser.is_super === 'true',
  context_id: req.params.branchId,
})
```

Policy checks then filter: `context_id IS NULL OR context_id = :branchId`. A user can be owner in Branch A and member in Branch B simultaneously.

---

## `is_super`

`is_super` on a user bypasses all policy checks. It exists for two reasons:

1. **Emergency fallback** — if all policies or groups are accidentally deleted, the `is_super` user can still access everything and recover the system.
2. **Account protection** — `is_super` users cannot be deleted or demoted by other admins (enforced in your team handlers, not by this package).

```ts
// team handler — prevent modification of is_super users
if (target.is_super === 'true') {
  return reply.status(403).send({ message: 'Cannot modify the owner account.' })
}
```

`is_super` is **not** a replacement for policy groups. Full access should still come from being assigned to an `admin` group. `is_super` is purely the break-glass account.

---

## Clearing the policy cache

Policies per user are cached in memory. Clear the cache when a user's group assignments change:

```ts
app.rbac.clearPolicyCache(userId)   // clear one user
app.rbac.clearPolicyCache()         // clear all
```

---

## Custom adapter (non-Drizzle)

Implement `RbacAdapter` to use any ORM or query builder:

```ts
import type { RbacAdapter } from '@kyrobit/rbac'

const myAdapter: RbacAdapter = {
  async upsertPolicies(rows) { /* ... */ },
  async listAllPolicies() { /* ... */ },
  async deleteGroupPolicies(ids) { /* ... */ },
  async deleteUserPolicies(ids) { /* ... */ },
  async deletePolicies(ids) { /* ... */ },
  async listGroups() { /* ... */ },
  async getGroupPolicies(groupId) { /* ... */ },
  async insertGroupPolicies(rows) { /* ... */ },
  async getSubjectGroupPolicies(subjectId, contextId) { /* ... */ },
  async getSubjectDirectPolicies(subjectId) { /* ... */ },
  async isResourceOwner(subjectId, resourceType, resourceId) { /* ... */ },
  async createResourceOwner(row) { /* ... */ },
}

await app.register(rbacPlugin, {
  adapter:    myAdapter,
  policies,
  getSubject: (req) => ({ id: req.user.id }),
})
```

---

## Exports

```ts
import {
  rbacPlugin,           // Fastify plugin
  createDrizzleAdapter, // built-in Drizzle adapter factory
  syncPolicies,         // sync function (used by CLI; call directly if needed)
  clearPolicyCache,     // invalidate policy cache
  addExtra,             // add metadata to next resource owner insert
  setContext,           // set subject + context for current request
  Policy,               // policy definition class

  // Drizzle schema tables (for use in your own queries / migrations)
  policies,
  policyGroups,
  policyGroupPolicies,
  userPolicyGroups,
  userPolicies,
  resourceOwners,
} from '@kyrobit/rbac'
```
