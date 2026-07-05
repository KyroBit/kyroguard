# Drizzle + MySQL

Set up @kyrobit/rbac on MySQL with Drizzle: scaffold the schema with `rbac init`, migrate it with drizzle-kit, wire `drizzleAdapter`, and wrap your database handle with `trackedDb`. MySQL has no `RETURNING` clause, so tracked inserts use Drizzle's `$returningId()` — this page shows where that matters.

::: tip Prerequisites
You have a project with `drizzle-orm` and `mysql2` installed, and you have read [Installation](/guide/installation). Policy and group syntax is covered in [Policies](/guide/defining-policies) and [Groups](/guide/organizing-groups) — this page uses the starter files as generated.
:::

## 1. Install the dependencies

```bash
npm install @kyrobit/rbac drizzle-orm mysql2
npm install -D drizzle-kit
```

The package is ESM-only and requires Node >= 20.19 (Bun works too). `drizzle-orm` is an optional peer dependency — the core entry point never imports it; only `@kyrobit/rbac/drizzle` does.

## 2. Scaffold with `rbac init`

`rbac init` detects MySQL from your `drizzle.config.*` (`dialect: 'mysql'`) or from the `mysql2` dependency:

```
$ npx rbac init
[rbac] Detected stack:
  framework: fastify
  orm:       drizzle
  dialect:   mysql

Framework (fastify/express) [fastify]:
ORM (drizzle/prisma/mongoose) [drizzle]:
Dialect (pg/mysql/sqlite) [mysql]:
Portal name [admin]:
  wrote   rbac.config.ts
  wrote   src/rbac/policies.ts
  wrote   src/rbac/groups.ts
  wrote   src/rbac/wiring.ts
  wrote   src/db/rbac-schema.ts

[rbac] Next steps:
  1. Add src/db/rbac-schema.ts to your drizzle config schema paths.
  2. Run your migrations (drizzle-kit generate && drizzle-kit migrate, or push).
  3. Finish the TODOs in rbac.config.ts and src/rbac/wiring.ts.
  4. Run `rbac sync`.
```

Pass `--yes` to accept the detected defaults without prompting. Existing files are never overwritten without confirmation.

## 3. Review the generated `src/db/rbac-schema.ts`

The schema file lives in your repository so drizzle-kit can migrate it alongside your own tables. It mirrors `@kyrobit/rbac/drizzle/schema/mysql` exactly:

```ts
// RBAC tables for @kyrobit/rbac (drizzle, mysql) — mirrors @kyrobit/rbac/drizzle/schema/mysql.
// Add this file to your drizzle-kit schema paths and migrate before `rbac sync`.
import { createId } from '@kyrobit/rbac'
import {
  boolean,
  index,
  json,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

export const dialect = 'mysql' as const

// varchar(191): max indexable utf8mb4 length that keeps 4-column unique keys
// under InnoDB's 3072-byte index limit.
const id = (name: string) => varchar(name, { length: 191 })

export const rbacPolicies = mysqlTable('rbac_policies', {
  id: id('id').primaryKey().$defaultFn(() => createId()),
  name: varchar('name', { length: 191 }).notNull().unique(),
  portal: varchar('portal', { length: 191 }).notNull().default(''),
  label: varchar('label', { length: 255 }).notNull(),
  scopeOptions: json('scope_options').$type<string[]>().notNull().default([]),
  dependsOn: json('depends_on').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const rbacPolicyGroups = mysqlTable('rbac_policy_groups', {
  id: id('id').primaryKey().$defaultFn(() => createId()),
  name: varchar('name', { length: 191 }).notNull().unique(),
  label: varchar('label', { length: 255 }).notNull(),
  description: text('description'),
  isSystem: boolean('is_system').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const rbacPolicyGroupPolicies = mysqlTable(
  'rbac_policy_group_policies',
  {
    id: id('id').primaryKey().$defaultFn(() => createId()),
    policyGroupId: id('policy_group_id')
      .notNull()
      .references(() => rbacPolicyGroups.id),
    policyId: id('policy_id')
      .notNull()
      .references(() => rbacPolicies.id),
    scope: varchar('scope', { length: 191 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [uniqueIndex('rbac_pgp_group_policy_uq').on(table.policyGroupId, table.policyId)],
)

export const rbacUserPolicyGroups = mysqlTable(
  'rbac_user_policy_groups',
  {
    id: id('id').primaryKey().$defaultFn(() => createId()),
    subjectId: id('subject_id').notNull(),
    policyGroupId: id('policy_group_id')
      .notNull()
      .references(() => rbacPolicyGroups.id),
    portal: varchar('portal', { length: 191 }).notNull().default(''),
    contextId: varchar('context_id', { length: 191 }).notNull().default(''),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [
    uniqueIndex('rbac_upg_tuple_uq').on(table.subjectId, table.policyGroupId, table.portal, table.contextId),
    index('rbac_upg_subject_idx').on(table.subjectId),
  ],
)

export const rbacUserPolicies = mysqlTable(
  'rbac_user_policies',
  {
    id: id('id').primaryKey().$defaultFn(() => createId()),
    subjectId: id('subject_id').notNull(),
    policyId: id('policy_id')
      .notNull()
      .references(() => rbacPolicies.id),
    portal: varchar('portal', { length: 191 }).notNull().default(''),
    contextId: varchar('context_id', { length: 191 }).notNull().default(''),
    scope: varchar('scope', { length: 191 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [
    uniqueIndex('rbac_up_tuple_uq').on(table.subjectId, table.policyId, table.portal, table.contextId),
    index('rbac_up_subject_idx').on(table.subjectId),
  ],
)

export const rbacResourceOwners = mysqlTable(
  'rbac_resource_owners',
  {
    id: id('id').primaryKey().$defaultFn(() => createId()),
    resourceType: varchar('resource_type', { length: 191 }).notNull(),
    resourceId: varchar('resource_id', { length: 191 }).notNull(),
    ownerId: varchar('owner_id', { length: 191 }).notNull(),
    contextType: varchar('context_type', { length: 191 }).notNull().default(''),
    contextId: varchar('context_id', { length: 191 }).notNull().default(''),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [
    uniqueIndex('rbac_ro_tuple_uq').on(table.resourceType, table.resourceId, table.ownerId),
    index('rbac_ro_resource_idx').on(table.resourceType, table.resourceId),
  ],
)

export const tables = {
  policies: rbacPolicies,
  policyGroups: rbacPolicyGroups,
  policyGroupPolicies: rbacPolicyGroupPolicies,
  userPolicyGroups: rbacUserPolicyGroups,
  userPolicies: rbacUserPolicies,
  resourceOwners: rbacResourceOwners,
} as const
```

Two MySQL-specific choices are baked in:

- **Every key column is `varchar(191)`.** utf8mb4 encodes up to 4 bytes per character, and InnoDB caps an index key at 3072 bytes. The widest indexes here span four columns (`subject_id, policy_id/policy_group_id, portal, context_id`), and 4 × 191 × 4 = 3056 bytes stays under the cap — 191 is the longest length that does. Longer columns would make the unique indexes fail to create.
- **`portal` and `context_id` are `NOT NULL DEFAULT ''`.** In SQL, `NULL` values never compare equal, so nullable columns inside a unique index would admit duplicate assignment rows. The `''` sentinel means "none", keeps matching plain equality, and makes the constraints behave identically across all supported backends — a grant with no context never applies to a request with one, which is what keeps tenant data isolated.

## 4. Register the schema with drizzle-kit and migrate

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'mysql',
  schema: ['./src/db/schema.ts', './src/db/rbac-schema.ts'],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

```bash
npx drizzle-kit generate
npx drizzle-kit migrate
```

This creates six tables:

| Table | Purpose |
| --- | --- |
| `rbac_policies` | Policy definitions synced from code |
| `rbac_policy_groups` | Named groups (roles) |
| `rbac_policy_group_policies` | Group → policy membership, with per-entry scope |
| `rbac_user_policy_groups` | Subject → group assignments per portal + context |
| `rbac_user_policies` | Direct subject → policy assignments per portal + context |
| `rbac_resource_owners` | Ownership rows backing `Scope.owned()` |

## 5. Wire the adapter

`rbac.config.ts` was generated with a lazy adapter factory — only `rbac sync` and `rbac status` open a connection:

```ts
// rbac.config.ts
import { defineConfig } from '@kyrobit/rbac'

export default defineConfig({
  adapter: async () => {
    const { drizzleAdapter } = await import('@kyrobit/rbac/drizzle')
    const schema = await import('./src/db/rbac-schema.js')
    const { db } = await import('./src/db/index.js')
    return drizzleAdapter(db, { schema })
  },
  portals: [
    {
      name: 'admin',
      policies: './src/rbac/policies.ts',
      groups: './src/rbac/groups.ts',
    },
  ],
  typegen: { output: './rbac.d.ts' },
})
```

Complete the one TODO by exporting your Drizzle instance:

```ts
// src/db/index.ts
import { drizzle } from 'drizzle-orm/mysql2'

export const db = drizzle(process.env.DATABASE_URL!)
```

In your application, construct the adapter once and hand it to `createRbac`. Pass the whole schema module — `drizzleAdapter` reads `schema.dialect` and `schema.tables` (the packaged `@kyrobit/rbac/drizzle/schema/mysql` exports the same shape):

```ts
// src/rbac/instance.ts
import { createRbac } from '@kyrobit/rbac'
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from '../db/rbac-schema.js'
import { db } from '../db/index.js'
import { resources } from './policies.js'

export const adapter = drizzleAdapter(db, { schema })
export const rbac = createRbac({ adapter, resources })
```

## 6. Sync and verify

```
$ npx rbac sync
[rbac] Synced 4 policies.
[rbac] Seeded 2 groups for portal "admin".
[rbac] Wrote /your/project/rbac.d.ts
```

::: warning Migrate before you sync
`rbac sync` writes rows — it does not create tables. Running it first fails with the driver's `ER_NO_SUCH_TABLE` error, and the CLI adds:

```
[rbac] The rbac tables do not exist yet — run your migrations first (drizzle-kit push / migrate).
```
:::

Confirm the adapter is wired and the data landed:

```
$ npx rbac status
adapter:      drizzle-mysql
capabilities: autoOwnershipTracking=true queryScoping=true
policies:     4
groups:       2
```

You can also check directly: `SHOW TABLES LIKE 'rbac\_%';` lists all six tables.

## Tracking ownership with `trackedDb`

`Scope.owned()` grants like `'posts.update': 'owned'` check `rbac_resource_owners`. Wrap your Drizzle handle with `trackedDb` so inserts into registered resource tables record ownership automatically for the current request's subject, and selects get portal-configured query scoping. `update`/`delete` are intentionally not intercepted.

Link your table in the resource definition and create the tracked handle:

```ts
// src/db/schema.ts
import { mysqlTable, text, timestamp, varchar } from 'drizzle-orm/mysql-core'
import { createId } from '@kyrobit/rbac'

export const posts = mysqlTable('posts', {
  id: varchar('id', { length: 191 }).primaryKey().$defaultFn(() => createId()),
  authorId: varchar('author_id', { length: 191 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  body: text('body'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
```

```ts
// src/rbac/policies.ts
import { Policy, Scope } from '@kyrobit/rbac'
import type { ResourceDefinition } from '@kyrobit/rbac'
import { posts } from '../db/schema.js'

export const resources: ResourceDefinition[] = [
  {
    type: 'post',
    table: posts,
    context: {
      admin: { 'posts.read': ['owned'] },
    },
    policies: [
      new Policy('posts.read'),
      new Policy('posts.create', 'Create posts', ['posts.read']),
      new Policy('posts.update', 'Update posts', ['posts.read'], [Scope.owned()]),
      new Policy('posts.delete', 'Delete posts', ['posts.read'], [Scope.owned()]),
    ],
  },
]
```

```ts
// src/db/tracked.ts
import { trackedDb } from '@kyrobit/rbac/drizzle'
import { eq } from 'drizzle-orm'
import { db as rawDb } from './index.js'
import { posts } from './schema.js'
import { adapter, rbac } from '../rbac/instance.js'
import { resources } from '../rbac/policies.js'

export const db = trackedDb(rawDb, {
  rbac: { engine: rbac.engine, adapter },
  resources,
  queryScopes: {
    owned: subject => (subject.is_super ? undefined : eq(posts.authorId, subject.id)),
  },
})
```

### Getting ids out of MySQL inserts

The tracked db needs the inserted ids to write ownership rows, and MySQL has no `RETURNING` clause. You have two options:

```ts
// Option A: $returningId() — Drizzle fetches the primary keys
// (works for autoincrement keys and for $defaultFn keys like the one above).
const [{ id }] = await db
  .insert(posts)
  .values({ title, authorId })
  .$returningId()

// Option B: generate the id yourself and pass it in values().
import { createId } from '@kyrobit/rbac'

const id = createId()
await db.insert(posts).values({ id, title, authorId })
```

Both paths record a `rbac_resource_owners` row for the request subject. Inside `db.transaction(...)` the ownership write goes through the same transaction, so it commits or rolls back atomically with the insert. Ownership extraction reads the `id` property of the values object or the returned rows — name your primary key property `id` in the Drizzle schema for tracked tables.

::: warning Inserts without ids are not tracked
An insert on a registered table with no ids in `values()` and no `.$returningId()` logs this once per resource and records nothing:

```
[rbac] Ownership not tracked for "post": no ids in values() and no .returning(). Add .returning(), pass ids in values(), or use db.untracked to silence.
```

Set `strictTracking: 'error'` in the `trackedDb` options to reject such inserts with a `MisconfiguredError` (`RBAC_MISCONFIGURED`, 500), or `'off'` to silence the warning.
:::

The consequence of an untracked insert appears later: the owner's request to a route guarded by an owned-scope policy is denied with `403`, because no `rbac_resource_owners` row exists. This is the exact body:

::: code-group

```json [Fastify]
{
  "statusCode": 403,
  "code": "RBAC_SCOPE_DENIED",
  "error": "Forbidden",
  "message": "Forbidden"
}
```

```json [Express]
{
  "message": "Forbidden",
  "code": "RBAC_SCOPE_DENIED"
}
```

:::

Selects on registered tables get the scope conditions for the subject's portal OR-combined, then AND-ed into your own `where()`. A scope builder opts a subject out by returning `undefined`. Requests with no subject (seeders, CLI scripts, jobs) run plain inserts and unscoped selects, and `db.untracked` exposes the raw handle. Error codes are listed in the [error reference](/reference/errors).

## MySQL notes

- **`json` columns.** `rbac_policies.scope_options` and `rbac_policies.depends_on` are MySQL `json` columns with a `[]` default (PostgreSQL uses `jsonb`). Defaults on `json` columns are expression defaults, which MySQL supports from 8.0.13.
- **`varchar(191)` keys.** See the schema walkthrough above — the length is dictated by InnoDB's 3072-byte index limit under utf8mb4, not by the id format (cuid2 ids are 24 characters).
- **Client-generated ids.** All primary keys default to cuid2 strings via `$defaultFn` — generated in JavaScript, not by the database. Rows inserted outside Drizzle must supply their own `id`.
- **Booleans** are stored the MySQL way (`boolean` maps to `tinyint(1)`); the adapter normalizes them to real booleans when reading.

## Next steps

- [Protecting routes](/guide/protecting-routes) — put `portal.requirePolicy()` in front of your handlers.
- [Scopes](/guide/writing-scopes) — how owned-scope checks and custom scopes resolve.
- [Drizzle + PostgreSQL](/databases/drizzle-postgres) or [Drizzle + SQLite](/databases/drizzle-sqlite) — the same flow on the other dialects.
