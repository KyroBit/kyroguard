# Custom Adapter

The library ships with a built-in Drizzle adapter and PostgreSQL schema. If you're using Drizzle with PostgreSQL, you don't need this page — just use `createDrizzleAdapter(db)`.

If you're on a different database (MySQL, SQLite) or a different ORM (Prisma, Kysely, raw SQL), implement the `RbacAdapter` interface and provide your own migrations.

---

## The interface

```ts
import type { RbacAdapter } from '@kyrobit/rbac'

const myAdapter: RbacAdapter = {
  // Called during rbac sync — upsert all policies from code
  upsertPolicies(rows) { ... },

  // Called during rbac sync — list all policies currently in the database
  listAllPolicies() { ... },

  // Called during rbac sync — delete orphaned policies
  deletePolicies(ids) { ... },

  // Called during rbac sync — remove group assignments for deleted policies
  deleteGroupPolicies(policyIds) { ... },

  // Called during rbac sync — remove user assignments for deleted policies
  deleteUserPolicies(policyIds) { ... },

  // Called during rbac sync — list all groups
  listGroups() { ... },

  // Called during rbac sync — get policies assigned to a group
  getGroupPolicies(groupId) { ... },

  // Called during rbac sync — insert missing dependency policies into a group
  insertGroupPolicies(rows) { ... },

  // Called at request time — get all policies for a user via their group memberships
  getSubjectGroupPolicies(subjectId, portal, contextId) { ... },

  // Called at request time — get policies assigned directly to a user
  getSubjectDirectPolicies(subjectId) { ... },
}
```

---

## Method details

### upsertPolicies

Called during sync. Receives all policy definitions from code. Insert or update each row.

```ts
upsertPolicies(rows: PolicyInsert[]): Promise<void>

interface PolicyInsert {
  name:         string
  label:        string
  depends_on:   string[]
  scopeOptions: string[]
}
```

### listAllPolicies

Returns all policy rows currently in the database. Used to detect policies that were removed from code.

```ts
listAllPolicies(): Promise<PolicyRow[]>

interface PolicyRow {
  id:         string
  name:       string
  depends_on: string[]
}
```

### getSubjectGroupPolicies

The hot path — called on every protected request. Returns all policies the user has via their group memberships, filtered to the exact portal and context combination.

```ts
getSubjectGroupPolicies(
  subjectId: string,
  portal:    string | null | undefined,
  contextId: string | null | undefined,
): Promise<{ name: string; scope: string | null }[]>
```

Return only rows where `portal` and `context_id` match exactly. No fallbacks — a user with no assignment for the current portal and context should get an empty result set.

### getSubjectDirectPolicies

Returns policies assigned directly to the user, not via a group.

```ts
getSubjectDirectPolicies(
  subjectId: string,
): Promise<{ name: string; scope: string | null }[]>
```

---

## Registering a custom adapter

```ts
await app.register(rbacPlugin, { adapter: myAdapter })

const rbac = app.rbac.forPortal('admin', (req) => ({ id: req.user.id }))
```

---

**Next:** [Policy Cache](./cache)
