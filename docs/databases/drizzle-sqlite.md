# Drizzle + SQLite

Set up @kyrobit/rbac on SQLite with Drizzle — a good fit for tests, prototypes and small single-node deployments. You scaffold the schema with `rbac init`, migrate it with drizzle-kit, wire `drizzleAdapter`, and wrap your database handle with `trackedDb`. Both `bun:sqlite` and `better-sqlite3` work.

::: tip Prerequisites
You have a project with `drizzle-orm` and a SQLite driver installed, and you have read [Installation](/guide/installation). Policy and group syntax is covered in [Policies](/guide/defining-policies) and [Groups](/guide/organizing-groups) — this page uses the starter files as generated.
:::

## 1. Install the dependencies

::: code-group

```bash [Bun]
bun add @kyrobit/rbac drizzle-orm
bun add -d drizzle-kit
# bun:sqlite is built in — no driver package needed
```

```bash [Node]
npm install @kyrobit/rbac drizzle-orm better-sqlite3
npm install -D drizzle-kit
```

:::

The package is ESM-only and requires Node >= 20.19 or Bun. `drizzle-orm` is an optional peer dependency — the core entry point never imports it; only `@kyrobit/rbac/drizzle` does.

## 2. Scaffold with `rbac init`

`rbac init` detects SQLite from your `drizzle.config.*` (`dialect: 'sqlite'` or `'turso'`) or from a `better-sqlite3` / `libsql` dependency:

```
$ npx rbac init
[rbac] Detected stack:
  framework: fastify
  orm:       drizzle
  dialect:   sqlite

Framework (fastify/express) [fastify]:
ORM (drizzle/prisma/mongoose) [drizzle]:
Dialect (pg/mysql/sqlite) [sqlite]:
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

The schema file lives in your repository so drizzle-kit can migrate it alongside your own tables. It mirrors `@kyrobit/rbac/drizzle/schema/sqlite` exactly:

```ts
// RBAC tables for @kyrobit/rbac (drizzle, sqlite) — mirrors @kyrobit/rbac/drizzle/schema/sqlite.
// Add this file to your drizzle-kit schema paths and migrate before `rbac sync`.
import { createId } from '@kyrobit/rbac'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const dialect = 'sqlite' as const

const timestampCol = (name: string) =>
  integer(name, { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())

export const rbacPolicies = sqliteTable('rbac_policies', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull().unique(),
  portal: text('portal').notNull().default(''),
  label: text('label').notNull(),
  scopeOptions: text('scope_options', { mode: 'json' }).$type<string[]>().notNull().default([]),
  dependsOn: text('depends_on', { mode: 'json' }).$type<string[]>().notNull().default([]),
  createdAt: timestampCol('created_at'),
  updatedAt: timestampCol('updated_at'),
})

export const rbacPolicyGroups = sqliteTable('rbac_policy_groups', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull().unique(),
  label: text('label').notNull(),
  description: text('description'),
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: timestampCol('created_at'),
  updatedAt: timestampCol('updated_at'),
})

export const rbacPolicyGroupPolicies = sqliteTable(
  'rbac_policy_group_policies',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    policyGroupId: text('policy_group_id')
      .notNull()
      .references(() => rbacPolicyGroups.id),
    policyId: text('policy_id')
      .notNull()
      .references(() => rbacPolicies.id),
    scope: text('scope'),
    createdAt: timestampCol('created_at'),
  },
  table => [uniqueIndex('rbac_pgp_group_policy_uq').on(table.policyGroupId, table.policyId)],
)

export const rbacUserPolicyGroups = sqliteTable(
  'rbac_user_policy_groups',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    subjectId: text('subject_id').notNull(),
    policyGroupId: text('policy_group_id')
      .notNull()
      .references(() => rbacPolicyGroups.id),
    portal: text('portal').notNull().default(''),
    contextId: text('context_id').notNull().default(''),
    createdAt: timestampCol('created_at'),
  },
  table => [
    uniqueIndex('rbac_upg_tuple_uq').on(table.subjectId, table.policyGroupId, table.portal, table.contextId),
    index('rbac_upg_subject_idx').on(table.subjectId),
  ],
)

export const rbacUserPolicies = sqliteTable(
  'rbac_user_policies',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    subjectId: text('subject_id').notNull(),
    policyId: text('policy_id')
      .notNull()
      .references(() => rbacPolicies.id),
    portal: text('portal').notNull().default(''),
    contextId: text('context_id').notNull().default(''),
    scope: text('scope'),
    createdAt: timestampCol('created_at'),
  },
  table => [
    uniqueIndex('rbac_up_tuple_uq').on(table.subjectId, table.policyId, table.portal, table.contextId),
    index('rbac_up_subject_idx').on(table.subjectId),
  ],
)

export const rbacResourceOwners = sqliteTable(
  'rbac_resource_owners',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    ownerId: text('owner_id').notNull(),
    contextType: text('context_type').notNull().default(''),
    contextId: text('context_id').notNull().default(''),
    createdAt: timestampCol('created_at'),
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

SQLite has no native boolean, timestamp or JSON column types, so the schema maps them onto its storage classes:

- **Timestamps** are `integer` columns in `mode: 'timestamp'` — Drizzle stores Unix epoch seconds and gives you `Date` objects back. Defaults come from `$defaultFn(() => new Date())`, generated in JavaScript, not by the database.
- **Booleans** (`is_system`, `is_active`) are `integer` columns in `mode: 'boolean'` — stored as 0/1.
- **JSON** (`scope_options`, `depends_on`) is `text` in `mode: 'json'` — stored as a JSON string, typed as `string[]`.
- **`portal` and `context_id` are `NOT NULL DEFAULT ''`.** In SQL, `NULL` values never compare equal, so nullable columns inside a unique index would admit duplicate assignment rows. The `''` sentinel means "none", keeps matching plain equality, and makes the constraints behave identically across all supported backends — a grant with no context never applies to a request with one, which is what keeps tenant data isolated.

## 4. Register the schema with drizzle-kit and migrate

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: ['./src/db/schema.ts', './src/db/rbac-schema.ts'],
  out: './drizzle',
  dbCredentials: { url: './app.db' },
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

`rbac.config.ts` was generated with a lazy adapter factory — only `rbac sync` and `rbac status` open the database:

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

Complete the one TODO by exporting your Drizzle instance with the driver you use:

::: code-group

```ts [bun:sqlite]
// src/db/index.ts
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'

const sqlite = new Database('./app.db')
export const db = drizzle(sqlite)
```

```ts [better-sqlite3]
// src/db/index.ts
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

const sqlite = new Database('./app.db')
export const db = drizzle(sqlite)
```

:::

In your application, construct the adapter once and hand it to `createRbac`. Pass the whole schema module — `drizzleAdapter` reads `schema.dialect` and `schema.tables` (the packaged `@kyrobit/rbac/drizzle/schema/sqlite` exports the same shape):

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

::: warning One process at a time
SQLite locks the whole database for writes, and with `bun:sqlite` or `better-sqlite3` the file is opened in-process. Run `rbac sync` while your dev server holds a write transaction and one of them waits or fails with `SQLITE_BUSY`. For anything with concurrent writers across processes, use [PostgreSQL](/databases/drizzle-postgres) or [MySQL](/databases/drizzle-mysql) — the rbac schema and API are identical, so switching later is a migration, not a rewrite.
:::

## 6. Sync and verify

```
$ npx rbac sync
[rbac] Synced 4 policies.
[rbac] Seeded 2 groups for portal "admin".
[rbac] Wrote /your/project/rbac.d.ts
```

If you skipped the migration, sync fails with the driver's `no such table` error and the CLI adds a hint to run `drizzle-kit push / migrate` first.

Confirm the adapter is wired and the data landed:

```
$ npx rbac status
adapter:      drizzle-sqlite
capabilities: autoOwnershipTracking=true queryScoping=true
policies:     4
groups:       2
```

You can also check directly: `sqlite3 app.db ".tables rbac_%"` lists all six tables.

## Tracking ownership with `trackedDb`

`Scope.owned()` grants like `'posts.update': 'owned'` check `rbac_resource_owners`. Wrap your Drizzle handle with `trackedDb` so inserts into registered resource tables record ownership automatically for the current request's subject, and selects get portal-configured query scoping. `update`/`delete` are intentionally not intercepted.

SQLite supports `RETURNING`, so tracked inserts look the same as on PostgreSQL:

```ts
// src/db/schema.ts
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { createId } from '@kyrobit/rbac'

export const posts = sqliteTable('posts', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  authorId: text('author_id').notNull(),
  title: text('title').notNull(),
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

Inside a request where a guard has resolved the subject:

```ts
const [post] = await db.insert(posts).values({ title, authorId }).returning()
// A row now exists in rbac_resource_owners:
// (resource_type: 'post', resource_id: post.id, owner_id: subject.id)
```

The Drizzle SQLite execution methods `.run()`, `.all()` and `.get()` are intercepted too, so tracking works whichever way you execute the query. Inside `db.transaction(...)` the ownership row is written through the same transaction, so it commits or rolls back atomically with the insert. Requests with no subject (seeders, tests, jobs) run plain inserts and unscoped selects, and `db.untracked` exposes the raw handle.

::: warning Inserts without ids are not tracked
An insert on a registered table with no ids in `values()` and no `.returning()` logs this once per resource and records nothing:

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

Error codes are listed in the [error reference](/reference/errors).

## SQLite notes

- **Use it for tests.** An in-memory database (`new Database(':memory:')`) plus `drizzle-kit push` gives each test suite a fresh, isolated rbac store with no external service. All three dialects share one `drizzleAdapter` implementation — only the table definitions differ — so behavior you assert against SQLite matches PostgreSQL and MySQL.
- **Client-generated values.** Ids (cuid2 via `$defaultFn`) and the `created_at`/`updated_at` timestamps are generated in JavaScript. Rows inserted outside Drizzle (raw SQL, `sqlite3` CLI) get neither — supply them yourself.
- **Timestamps are epoch seconds.** When inspecting rows with the `sqlite3` CLI, `created_at` is an integer like `1751702400`, not an ISO string.
- **Booleans are 0/1 integers** in the file; the adapter returns real booleans.
- **JSON is text.** `scope_options` and `depends_on` are JSON strings; the adapter parses them when reading.

## Next steps

- [Protecting routes](/guide/protecting-routes) — put `portal.requirePolicy()` in front of your handlers.
- [Scopes](/guide/writing-scopes) — how owned-scope checks and custom scopes resolve.
- [Drizzle + PostgreSQL](/databases/drizzle-postgres) — the same flow for production deployments with concurrent writers.
