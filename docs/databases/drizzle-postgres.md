# Drizzle + PostgreSQL

Set up @kyrobit/rbac on PostgreSQL with Drizzle: scaffold the schema with `rbac init`, migrate it with drizzle-kit, wire `drizzleAdapter`, and wrap your database handle with `trackedDb` for automatic ownership tracking.

::: tip Prerequisites
You have a project with `drizzle-orm` and a PostgreSQL driver installed, and you have read [Installation](/guide/installation). Policy and group syntax is covered in [Policies](/guide/defining-policies) and [Groups](/guide/organizing-groups) — this page uses the starter files as generated.
:::

## 1. Install the dependencies

```bash
npm install @kyrobit/rbac drizzle-orm pg
npm install -D drizzle-kit
```

The package is ESM-only and requires Node >= 20.19 (Bun works too). `drizzle-orm` is an optional peer dependency — the core entry point never imports it; only `@kyrobit/rbac/drizzle` does.

## 2. Scaffold with `rbac init`

`rbac init` inspects your `package.json` and `drizzle.config.*` to detect your stack, then asks four questions. Accept the detected defaults, or pass `--yes` to skip the prompts entirely:

```
$ npx rbac init
[rbac] Detected stack:
  framework: fastify
  orm:       drizzle
  dialect:   pg

Framework (fastify/express) [fastify]:
ORM (drizzle/prisma/mongoose) [drizzle]:
Dialect (pg/mysql/sqlite) [pg]:
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

Existing files are never overwritten without confirmation; `--yes` always skips existing files.

## 3. Review the generated `src/db/rbac-schema.ts`

The schema file is plain Drizzle table definitions — it lives in your repository so drizzle-kit can migrate it alongside your own tables, and it mirrors `@kyrobit/rbac/drizzle/schema/pg` exactly:

```ts
// RBAC tables for @kyrobit/rbac (drizzle, pg) — mirrors @kyrobit/rbac/drizzle/schema/pg.
// Add this file to your drizzle-kit schema paths and migrate before `rbac sync`.
import { createId } from '@kyrobit/rbac'
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const dialect = 'pg' as const

export const rbacPolicies = pgTable('rbac_policies', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull().unique(),
  portal: text('portal').notNull().default(''),
  label: text('label').notNull(),
  scopeOptions: jsonb('scope_options').$type<string[]>().notNull().default([]),
  dependsOn: jsonb('depends_on').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const rbacPolicyGroups = pgTable('rbac_policy_groups', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull().unique(),
  label: text('label').notNull(),
  description: text('description'),
  isSystem: boolean('is_system').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const rbacPolicyGroupPolicies = pgTable(
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
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [uniqueIndex('rbac_pgp_group_policy_uq').on(table.policyGroupId, table.policyId)],
)

export const rbacUserPolicyGroups = pgTable(
  'rbac_user_policy_groups',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    subjectId: text('subject_id').notNull(),
    policyGroupId: text('policy_group_id')
      .notNull()
      .references(() => rbacPolicyGroups.id),
    portal: text('portal').notNull().default(''),
    contextId: text('context_id').notNull().default(''),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [
    uniqueIndex('rbac_upg_tuple_uq').on(table.subjectId, table.policyGroupId, table.portal, table.contextId),
    index('rbac_upg_subject_idx').on(table.subjectId),
  ],
)

export const rbacUserPolicies = pgTable(
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
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [
    uniqueIndex('rbac_up_tuple_uq').on(table.subjectId, table.policyId, table.portal, table.contextId),
    index('rbac_up_subject_idx').on(table.subjectId),
  ],
)

export const rbacResourceOwners = pgTable(
  'rbac_resource_owners',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    ownerId: text('owner_id').notNull(),
    contextType: text('context_type').notNull().default(''),
    contextId: text('context_id').notNull().default(''),
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

Two details worth noting:

- Ids are cuid2 strings generated client-side by `$defaultFn(() => createId())` — `createId` is re-exported from `@kyrobit/rbac` so this file needs no direct dependency on `@paralleldrive/cuid2` (strict pnpm layouts stay happy).
- `portal` and `context_id` are `NOT NULL DEFAULT ''`. The empty string is a sentinel meaning "none". This is deliberate: in SQL, `NULL` values never compare equal, so a nullable context column would let the four-column unique indexes admit duplicate assignment rows, and lookups would need `IS NULL` branches. With the `''` sentinel, matching is plain equality and the unique constraints behave identically on PostgreSQL, MySQL, SQLite and MongoDB — a grant with no context can never leak into a request that has one, which is what keeps tenant data isolated.

## 4. Register the schema with drizzle-kit and migrate

Add the generated file to your drizzle-kit schema paths:

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/db/schema.ts', './src/db/rbac-schema.ts'],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

Then generate and run the migration (or use `drizzle-kit push` in development):

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

`rbac init` wrote `rbac.config.ts` with a lazy adapter factory — only database-touching commands (`rbac sync`, `rbac status`) open a connection, and the CLI itself never imports a driver:

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

Complete the one TODO by exporting your Drizzle instance from `src/db/index.ts`:

```ts
// src/db/index.ts
import { drizzle } from 'drizzle-orm/node-postgres'

export const db = drizzle(process.env.DATABASE_URL!)
```

In your application, construct the same adapter once and hand it to `createRbac`. Pass the whole schema module — `drizzleAdapter` reads `schema.dialect` and `schema.tables`:

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

The packaged module `@kyrobit/rbac/drizzle/schema/pg` exports the same `dialect` and `tables` and also works here; using the generated file keeps the adapter and your migrations pointed at one definition.

## 6. Sync and verify

Push your policies and groups into the new tables, and generate `rbac.d.ts` for typed policy names:

```
$ npx rbac sync
[rbac] Synced 4 policies.
[rbac] Seeded 2 groups for portal "admin".
[rbac] Wrote /your/project/rbac.d.ts
```

::: warning Migrate before you sync
`rbac sync` writes to `rbac_policies` and friends — it does not create tables. Run it before migrating and it fails:

```
[rbac] sync failed: relation "rbac_policies" does not exist
[rbac] The rbac tables do not exist yet — run your migrations first (drizzle-kit push / migrate).
```
:::

Confirm the adapter is wired and the data landed:

```
$ npx rbac status
adapter:      drizzle-pg
capabilities: autoOwnershipTracking=true queryScoping=true
policies:     4
groups:       2
```

You can also check the tables directly with `psql`: `\dt rbac_*` lists all six.

## Tracking ownership with `trackedDb`

`Scope.owned()` grants like `'posts.update': 'owned'` check `rbac_resource_owners`. Rather than writing those rows by hand, wrap your Drizzle handle with `trackedDb`: inserts into registered resource tables record ownership automatically for the current request's subject, and selects get portal-configured query scoping. `update`/`delete` are intentionally not intercepted.

First, define the resource table with an `id` property (the tracked db reads the `id` property of the values object or the returned rows, so name your primary key property `id`):

```ts
// src/db/schema.ts
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { createId } from '@kyrobit/rbac'

export const posts = pgTable('posts', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  authorId: text('author_id').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
```

Then link the table in the resource definition (the starter file has this commented out):

```ts
// src/rbac/policies.ts
import { Policy, Scope } from '@kyrobit/rbac'
import type { ResourceDefinition } from '@kyrobit/rbac'
import { posts } from '../db/schema.js'

export const resources: ResourceDefinition[] = [
  {
    type: 'post',
    table: posts,
    // Query scoping: for admin-portal subjects, selects on `posts`
    // apply the 'owned' condition defined below.
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

Then create the tracked handle and use it everywhere your request handlers touch the database:

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
    // Return undefined to skip scoping for this subject.
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

How it behaves:

- **Inserts** into registered tables record one ownership row per inserted id. Ids come from `values()` (if you pass them) or from `.returning()`. Inside `db.transaction(...)` the ownership row is written through the same transaction, so it commits or rolls back atomically with the resource insert.
- **Selects** on registered tables get the scope conditions for the subject's portal OR-combined, then AND-ed into your own `where()`. Scoping applies to every subject on that portal; a scope builder opts a subject out by returning `undefined`.
- **No subject** (seeders, CLI scripts, background jobs) means a plain insert — there is nobody to attribute ownership to.
- **`db.untracked`** exposes the raw handle when you want neither tracking nor scoping.

::: warning Inserts without ids are not tracked
PostgreSQL only reports inserted ids when you ask for them. An insert on a registered table with no ids in `values()` and no `.returning()` logs this once per resource and records nothing:

```
[rbac] Ownership not tracked for "post": no ids in values() and no .returning(). Add .returning(), pass ids in values(), or use db.untracked to silence.
```

Set `strictTracking: 'error'` in the `trackedDb` options to reject such inserts with a `MisconfiguredError` (`RBAC_MISCONFIGURED`, 500) instead of warning, or `'off'` to silence the warning.
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

Fastify serializes the thrown `ScopeDeniedError` through its own error pipeline (which adds `statusCode` and `error`); the Express `errorHandler()` sends the error's `toBody()` shape. All codes are listed in the [error reference](/reference/errors).

## PostgreSQL notes

- **jsonb columns.** `rbac_policies.scope_options` and `rbac_policies.depends_on` are `jsonb` with a `'[]'` default, typed as `string[]` through Drizzle's `$type`. The other dialects use `json` (MySQL) or JSON-in-`text` (SQLite); the adapter normalizes all three when reading.
- **Text primary keys.** Ids are cuid2 strings generated in JavaScript, not by the database. Rows inserted outside Drizzle (raw SQL, other tools) must supply their own `id`.
- **`.returning()` is native.** PostgreSQL's `RETURNING` makes tracked inserts the least ceremonial of the three dialects — MySQL needs [`$returningId()`](/databases/drizzle-mysql) instead.
- **Timestamps** are `timestamp` (without time zone) with `DEFAULT now()`.

## Next steps

- [Protecting routes](/guide/protecting-routes) — put `portal.requirePolicy()` in front of your handlers.
- [Scopes](/guide/writing-scopes) — how owned-scope checks and custom scopes resolve.
- [Portals & context](/guide/tenant-contexts) — how the `portal` and `context_id` columns isolate tenants.
