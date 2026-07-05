# Drizzle

Works with PostgreSQL, MySQL and SQLite. Setup is four steps: scaffold, migrate, wire the adapter, sync. Ownership tracking is an optional fifth.

## 1. Scaffold

Run init in your project root:

```bash
npx rbac init
```

It detects Drizzle and your dialect, then writes the starter files:

```
[rbac] Detected stack:
  framework: fastify
  orm:       drizzle
  dialect:   pg

  wrote   rbac.config.ts
  wrote   src/rbac/policies.ts
  wrote   src/rbac/groups.ts
  wrote   src/rbac/wiring.ts
  wrote   src/db/rbac-schema.ts
```

On MySQL and SQLite the detected dialect reads `mysql` or `sqlite`. The file list is the same. `src/db/rbac-schema.ts` holds the six rbac tables for your dialect.

## 2. Migrate

Add the rbac schema file to your drizzle-kit config:

::: code-group

```ts [PostgreSQL]
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/db/schema.ts', './src/db/rbac-schema.ts'],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

```ts [MySQL]
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'mysql',
  schema: ['./src/db/schema.ts', './src/db/rbac-schema.ts'],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

```ts [SQLite]
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: ['./src/db/schema.ts', './src/db/rbac-schema.ts'],
  out: './drizzle',
  dbCredentials: { url: './app.db' },
})
```

:::

Then generate and run the migration:

```bash
npx drizzle-kit generate
npx drizzle-kit migrate
```

`npx drizzle-kit push` also works during development. Migrate before you sync. `rbac sync` writes rows, it never creates tables.

## 3. Wire the adapter

Pass your Drizzle db and the scaffolded schema module to `drizzleAdapter`:

```ts
// src/rbac/instance.ts
import { createRbac } from '@kyrobit/rbac'
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from '../db/rbac-schema.js'
import { rawDb } from '../db/index.js'
import { resources } from './policies.js'

export const adapter = drizzleAdapter(rawDb, { schema })
export const rbac = createRbac({ adapter, resources })
```

`rbac.config.ts` contains the same wiring for the CLI. Finish its TODO so it imports your db. The scaffolded schema file mirrors `@kyrobit/rbac/drizzle/schema/pg` (and `mysql`, `sqlite`). Either module works as the `schema` option.

## 4. Sync

```bash
npx rbac sync
```

This writes your policies and groups into the rbac tables. It also generates `rbac.d.ts` for typed policy names. Re-run it whenever they change. Details in [Sync](/guide/sync).

## 5. Track ownership (optional)

Policies with `Scope.owned()` check who created each row. `trackedDb` records that for you. Wrap your db once and use the wrapped handle in request handlers:

```ts
// src/rbac/instance.ts
import { trackedDb } from '@kyrobit/rbac/drizzle'

export const db = trackedDb(rawDb, { rbac, resources })
```

Link each resource to its table in `src/rbac/policies.ts`:

```ts
import { Policy, Scope } from '@kyrobit/rbac'
import { posts } from '../db/schema.js'
import type { ResourceDefinition } from '@kyrobit/rbac'

export const resources: ResourceDefinition[] = [
  {
    type: 'post',
    table: posts,
    policies: [
      new Policy('posts.read'),
      new Policy('posts.update', 'Update posts', ['posts.read'], [Scope.owned()]),
    ],
  },
]
```

Now inserts into `posts` record the current user as the owner:

```ts
const [post] = await db.insert(posts).values({ title }).returning()
```

Tracking needs the new row's id. On PostgreSQL and SQLite, chain `.returning()`. MySQL cannot return rows from an insert. There, pass ids in `values()` or chain `.$returningId()`. An insert that yields no id records nothing and logs a warning.

Three more things to know:

- Writes with no logged-in user (seeders, jobs, scripts) record nothing.
- `db.untracked` is the raw handle when you want a plain insert.
- `trackedDb` can also filter list queries per user. See the [Drizzle reference](/reference/drizzle).

## Next steps

- [Assigning access](/guide/assigning-access) — give users groups and policies.
- [Protecting routes](/guide/protecting-routes) — put guards in front of handlers.
- [Ownership](/guide/ownership) — how owned-scope checks resolve.
- [Drizzle reference](/reference/drizzle) — every option of `drizzleAdapter` and `trackedDb`.
