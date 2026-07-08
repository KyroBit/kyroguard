# Drizzle

Works with PostgreSQL, MySQL and SQLite. Setup is four steps: scaffold, migrate, wire the adapter, sync. Ownership tracking is an optional fifth.

## 1. Scaffold

Run init in your project root:

```bash
npx kyroguard init
```

It detects Drizzle and your dialect, then writes the starter files:

```
[kyroguard] Detected stack:
  framework: fastify
  orm:       drizzle
  dialect:   pg

  wrote   kyroguard.config.ts
  wrote   src/kyroguard/policies/admin.ts
  wrote   src/kyroguard/groups/admin.ts
  wrote   src/kyroguard/domains.ts
  wrote   src/db/kyroguard-schema.ts
```

On MySQL and SQLite the detected dialect reads `mysql` or `sqlite`. The file list is the same. `src/db/kyroguard-schema.ts` holds the six kyroguard tables for your dialect.

## 2. Migrate

Add the kyroguard schema file to your drizzle-kit config. Your dialect and credentials stay as they are:

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql', // or 'mysql' / 'sqlite'
  schema: ['./src/db/schema.ts', './src/db/kyroguard-schema.ts'],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

Then generate and run the migration:

```bash
npx drizzle-kit generate
npx drizzle-kit migrate
```

`npx drizzle-kit push` also works during development. Migrate before you sync. `kyroguard sync` writes rows, it never creates tables.

## 3. Wire the adapter

Pass your Drizzle db and the scaffolded schema module to `drizzleAdapter`:

```ts
// src/kyroguard/instance.ts
import { createGuard } from '@kyrobit/kyroguard'
import { drizzleAdapter } from '@kyrobit/kyroguard/drizzle'
import * as schema from '../db/kyroguard-schema.js'
import { rawDb } from '../db/index.js'
import { resources } from './policies.js'

export const adapter = drizzleAdapter(rawDb, { schema })
export const guard = createGuard({ adapter, resources })
```

`kyroguard.config.ts` contains the same wiring for the CLI. Finish its TODO so it imports your db. The scaffolded schema file mirrors `@kyrobit/kyroguard/drizzle/schema/pg` (and `mysql`, `sqlite`). Either module works as the `schema` option.

## 4. Sync

```bash
npx kyroguard sync
```

This writes your policies and groups into the kyroguard tables. It also generates `kyroguard.d.ts` for typed policy names. Re-run it whenever they change. Details in [Sync](/guide/sync).

## 5. Track ownership (optional)

Policies with `Scope.owned()` check who created each row. `trackedDb` records that for you. Wrap your db once and use the wrapped handle in request handlers:

```ts
// src/kyroguard/instance.ts
import { trackedDb } from '@kyrobit/kyroguard/drizzle'

export const db = trackedDb(rawDb, { guard, resources })
```

Link each resource to its table in its policies file:

```ts
import { Policy, Scope } from '@kyrobit/kyroguard'
import { grades } from '../db/schema.js'
import type { ResourceDefinition } from '@kyrobit/kyroguard'

export const resources: ResourceDefinition[] = [
  {
    type: 'grade',
    table: grades,
    policies: [
      new Policy('grades.view'),
      new Policy('grades.update', { dependsOn: ['grades.view'], scopeOptions: [Scope.owned()] }),
    ],
  },
]
```

Now inserts into `grades` record the current user — the teacher — as the owner:

```ts
const [grade] = await db.insert(grades).values({ student, subject, score }).returning()
```

Tracking needs the new row's id. On PostgreSQL and SQLite, chain `.returning()`. MySQL cannot return rows from an insert. There, pass ids in `values()` or chain `.$returningId()`. An insert that yields no id records nothing and logs a warning.

Three more things to know:

- Writes with no logged-in user (seeders, jobs, scripts) record nothing.
- `db.untracked` is the raw handle when you want a plain insert.
- On a guarded route, selects on `grades` come back filtered by the guard's grant — [Automatic filtering](/guide/scopes#automatic-filtering), [Drizzle reference](/reference/drizzle#how-selects-are-filtered).

## Next steps

- [Assigning access](/guide/assigning-access) — give users groups and policies.
- [Protecting routes](/guide/protecting-routes) — put guards in front of handlers.
- [Ownership](/guide/ownership) — how owned-scope checks resolve.
- [Drizzle reference](/reference/drizzle) — every option of `drizzleAdapter` and `trackedDb`.
