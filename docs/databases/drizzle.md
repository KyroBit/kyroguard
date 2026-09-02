# Drizzle

Works with PostgreSQL, MySQL and SQLite. Setup is four steps: scaffold, migrate, wire the adapter, sync. Automatic query filtering is an optional fifth.

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

## 5. Filter queries automatically (optional)

A [scope](/guide/scopes) narrows what a grant reaches. `scopedDb` is what applies it: wrap your db once and use the wrapped handle in request handlers.

```ts
// src/kyroguard/instance.ts
import { scopedDb } from '@kyrobit/kyroguard/drizzle'

export const db = scopedDb(rawDb, { guard, resources })
```

Link each resource to its table in its policies file, and write the scope against your own columns:

```ts
import { Policy, Scope } from '@kyrobit/kyroguard'
import { eq } from 'drizzle-orm'
import { grades } from '../db/schema.js'
import type { ResourceDefinition } from '@kyrobit/kyroguard'

const entered = new Scope('entered', 'Entered by the teacher', subject => ({
  where: eq(grades.enteredBy, subject.id),
}))

export const resources: ResourceDefinition[] = [
  {
    type: 'grade',
    table: grades,
    policies: [
      new Policy('grades.view'),
      new Policy('grades.update', { dependsOn: ['grades.view'], scopeOptions: [entered] }),
    ],
  },
]
```

On a guarded route, every query against `grades` now carries that grant's condition:

```ts
await db.select().from(grades)                      // only their grades
await db.update(grades).set({ score }).where(eq(grades.id, id))  // matches nothing if not theirs
await db.delete(grades).where(eq(grades.id, id))    // same
```

Selects, joins, `db.query`, updates and deletes are all covered. Inserts are not: fill the owner column yourself, in the handler that creates the row.

Three more things to know:

- Queries with no guard in front of them (seeders, jobs, scripts) run unfiltered.
- `db.unscoped(reason)` is the raw handle, for reasons you register up front in `scopedDb({ unscoped: [...] })`.
- Details and the exact coverage: [Automatic filtering](/guide/scopes#automatic-filtering), [Drizzle reference](/reference/drizzle#how-selects-are-filtered).

## Next steps

- [Assigning access](/guide/assigning-access) — give users groups and policies.
- [Protecting routes](/guide/protecting-routes) — put guards in front of handlers.
- [Ownership](/guide/ownership) — the owner-column pattern behind an "own rows only" scope.
- [Drizzle reference](/reference/drizzle) — every option of `drizzleAdapter` and `scopedDb`.
