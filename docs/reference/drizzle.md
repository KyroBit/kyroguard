# Drizzle

Reference for `@kyrobit/kyroguard/drizzle`. Supports PostgreSQL, MySQL and SQLite with `drizzle-orm` >=0.36.0. Setup walkthrough: [Drizzle](/databases/drizzle).

## drizzleAdapter()

```ts
import { drizzleAdapter } from '@kyrobit/kyroguard/drizzle'

function drizzleAdapter(db: unknown, options: { schema: DrizzleKyroguardSchema }): StorageAdapter
```

| Parameter | Type | Description |
| --- | --- | --- |
| `db` | `unknown` | A Drizzle database handle for the matching dialect. |
| `options.schema` | `DrizzleKyroguardSchema` | The whole schema module: `import * as schema from '@kyrobit/kyroguard/drizzle/schema/pg'`. |

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { drizzleAdapter } from '@kyrobit/kyroguard/drizzle'
import * as schema from '@kyrobit/kyroguard/drizzle/schema/pg'

const db = drizzle(process.env.DATABASE_URL!)
const adapter = drizzleAdapter(db, { schema })
```

The returned adapter:

- `id`: `'drizzle-pg'`, `'drizzle-mysql'` or `'drizzle-sqlite'`, from the schema's dialect.
- `capabilities`: `{ listFiltering: true }`.
- Does not create tables. Run your Drizzle Kit migrations before `kyroguard sync`.
- Has no `close()` — Drizzle drivers expose no uniform disconnect API, so you own the connection lifecycle (`client.end()`, `pool.end()`, …). The CLI still always terminates: it exits explicitly after `sync`/`status`.
- Multi-step writes run in a transaction.
- Throws `UnknownPolicyError` when an assignment names an unsynced policy.

### Combining fragments

The adapter implements `listFilters` for [`filterFor`](/reference/core-api#filterfor): `or` is Drizzle's `or(...)` and `none` is `sql\`1 = 0\``. They are used only when a subject holds one policy under two [scopes](/guide/scopes) — the fragments themselves come from your scopes, written with Drizzle's own operators against your tables.

## scopedDb()

```ts
import { scopedDb } from '@kyrobit/kyroguard/drizzle'

function scopedDb<T extends object>(db: T, options: ScopedDbOptions): T & { unscoped: T }
```

Wraps your Drizzle database. Queries against a registered resource's table carry the grant of the route's guard — selects, joins, `db.query`, updates and deletes. `db.unscoped(reason)` is the raw handle, for a reason registered in `scopedDb({ unscoped: [...] })`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `guard` | `Guard` | required | Your `createGuard` instance. |
| `resources` | `ResourceDefinition[]` | required | Only resources with a `table` are filtered. Other tables pass through. |
| `unscoped` | `readonly string[]` | `[]` | Reasons `db.unscoped(reason)` accepts. Omit it and nothing may bypass. |

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { scopedDb } from '@kyrobit/kyroguard/drizzle'
import { guard } from './kyroguard/domains.js'
import { resources } from './kyroguard/policies.js'

const rawDb = drizzle(process.env.DATABASE_URL!)

export const db = scopedDb(rawDb, { guard, resources })
```

### What gets filtered

Every path to a registered table carries the same condition, so a grant cannot write to rows it cannot read: `db.select()`, `db.selectDistinct()`, joins (the condition goes in the `ON`, so a `leftJoin` keeps its left rows), `db.query.*`, `db.update()` and `db.delete()`.

**Inserts are not filtered and record nothing.** kyroguard writes no rows of its own about your data, so an owner or tenant column is yours to fill in the handler that creates the row. See [Ownership](/guide/ownership).

Queries on a request no guard filtered — seeders, jobs, unguarded handlers — run plainly.

### How selects are filtered

[Automatic filtering](/guide/scopes#automatic-filtering) is guard-driven: when the route's `requirePolicy` allows, it activates the exercised policy's decision for that policy's resource ([`storeFilterFor`](/reference/core-api#storefilterfor)). `db.select()` and `db.selectDistinct()` with `.from()` on a registered table apply the active decision: `all` leaves the query untouched, `none` compiles to an impossible `WHERE`, `where` is `AND`ed with your own `.where()`.

A filter belongs to the table, not to how you reached it: `from()`, `innerJoin`/`leftJoin` (applied in the `ON` condition, so a left join keeps its left rows), `update`, `delete` and `db.query` all carry it.

`db.query` is filtered on the root config and on `many` relations, recursively. Drizzle exposes no `where` for a `one` relation, so one pointing at a filtered resource throws synchronously rather than returning rows the grant denies — load it with `db.select()` and a join instead.

Queries run unfiltered when no guard activated a filter for the resource — unguarded routes, seeders, jobs — through `db.unscoped(reason)`, and while a scope is building its own fragment: a scope querying the db sees the whole table. Raw SQL is never intercepted.

## Schema subpaths

```ts
import * as schema from '@kyrobit/kyroguard/drizzle/schema/pg'     // PostgreSQL
import * as schema from '@kyrobit/kyroguard/drizzle/schema/mysql'  // MySQL
import * as schema from '@kyrobit/kyroguard/drizzle/schema/sqlite' // SQLite
```

Each module exports the same names. Pass the whole module to `drizzleAdapter` as `schema`.

| Export | Table |
| --- | --- |
| `kyroguardPolicies` | `kyroguard_policies` |
| `kyroguardPolicyGroups` | `kyroguard_policy_groups` |
| `kyroguardPolicyGroupPolicies` | `kyroguard_policy_group_policies` |
| `kyroguardUserPolicyGroups` | `kyroguard_user_policy_groups` |
| `kyroguardUserPolicies` | `kyroguard_user_policies` |
| `dialect` | `'pg'`, `'mysql'` or `'sqlite'` |
| `tables` | Barrel object consumed by `drizzleAdapter` |

Column-by-column details are in [Database schema](/reference/database-schema).
