# Drizzle

Reference for `@kyrobit/kyroguard/drizzle`. Supports PostgreSQL, MySQL and SQLite with `drizzle-orm` >=0.36.0. Setup walkthrough: [Drizzle](/databases/drizzle).

## drizzleAdapter()

```ts
import { drizzleAdapter } from '@kyrobit/kyroguard/drizzle'

function drizzleAdapter(db: unknown, options: { schema: DrizzleKyroguardSchema }): DrizzleStorageAdapter
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
- `capabilities`: `{ autoOwnershipTracking: true, listFiltering: true }`.
- Does not create tables. Run your Drizzle Kit migrations before `kyroguard sync`.
- Has no `close()` — Drizzle drivers expose no uniform disconnect API, so you own the connection lifecycle (`client.end()`, `pool.end()`, …). The CLI still always terminates: it exits explicitly after `sync`/`status`.
- Multi-step writes run in a transaction.
- Throws `UnknownPolicyError` when an assignment names an unsynced policy.

### List filters

The adapter implements `listFilters` for [`filterFor`](/reference/core-api#filterfor). The built-in scopes compile to one correlated EXISTS against `kyroguard_resource_owners` — no extra round trip, and it composes into any query without disturbing joins or pagination:

```sql
EXISTS (SELECT 1 FROM kyroguard_resource_owners ro
        WHERE ro.resource_type = 'grade'
          AND ro.resource_id = CAST(grades.id AS text)
          AND ro.owner_id = 'user-id'
          AND ro.relation = 'owner')
```

The correlated id column is the resource's `fields.id` mapping when set, otherwise the registered `table`'s `id` column. A resource with neither fails closed — its lists come back empty. `resource_id` is stored as text, so the id column is cast (`text` on PostgreSQL and SQLite, `char(191)` on MySQL).

## trackedDb()

```ts
import { trackedDb } from '@kyrobit/kyroguard/drizzle'

function trackedDb<T extends object>(db: T, options: TrackedDbOptions): T & { untracked: T }
```

Wraps your Drizzle database. Inserts into registered resource tables record ownership for the current user; selects on registered tables come back filtered by the grant of the route's guard. `db.untracked(reason)` is the raw handle, for a reason registered in `trackedDb({ untracked: [...] })`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `guard` | `Guard` | required | Your `createGuard` instance. |
| `resources` | `ResourceDefinition[]` | required | Only resources with a `table` are tracked and filtered. Other tables pass through. |
| `strictTracking` | `'warn' \| 'error' \| 'off'` | `'warn'` | What to do when an insert's ids cannot be read. |

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { trackedDb } from '@kyrobit/kyroguard/drizzle'
import { guard } from './kyroguard/domains.js'
import { resources } from './kyroguard/policies.js'

const rawDb = drizzle(process.env.DATABASE_URL!)

export const db = trackedDb(rawDb, { guard, resources })
```

### What gets tracked

An insert needs the new row ids. The wrapper reads them from `values()` rows that carry an `id`, or from a `.returning()` result. When no user is set on the request, seeders and jobs for example, the insert runs plainly. Inside a transaction, the ownership row commits together with the insert.

Updates and deletes carry the same filter as selects, so a grant cannot write to rows it cannot read. Ownership rows are not removed for you — call `guard.ownership.remove()` when you delete an owned resource. An insert that may not have written the row it names — `onConflictDoNothing`, `onConflictDoUpdate` — is attributed only from `.returning()`, so a conflicting write never takes ownership of someone else's row.

::: warning
An insert without ids in `values()` and without `.returning()` cannot be attributed. Set `strictTracking: 'error'` in development to catch these paths. Use `db.untracked(reason)` where skipping is intentional — the reason must be registered in `trackedDb({ untracked: [...] })`.
:::

### How selects are filtered

[Automatic filtering](/guide/scopes#automatic-filtering) is guard-driven: when the route's `requirePolicy` allows, it activates the exercised policy's decision for that policy's resource ([`storeFilterFor`](/reference/core-api#storefilterfor)). `db.select()` and `db.selectDistinct()` with `.from()` on a registered table apply the active decision: `all` leaves the query untouched, `none` compiles to an impossible `WHERE`, `where` is `AND`ed with your own `.where()`.

A filter belongs to the table, not to how you reached it: `from()`, `innerJoin`/`leftJoin` (applied in the `ON` condition, so a left join keeps its left rows), `update`, `delete` and `db.query` all carry it.

`db.query` is filtered on the root config and on `many` relations, recursively. Drizzle exposes no `where` for a `one` relation, so one pointing at a filtered resource throws synchronously rather than returning rows the grant denies — load it with `db.select()` and a join instead.

Queries run unfiltered when no guard activated a filter for the resource — unguarded routes, seeders, jobs — through `db.untracked(reason)`, and while the engine itself is deciding: scope checks, filter halves and resource resolvers see the whole table. Raw SQL is never intercepted.

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
| `kyroguardResourceOwners` | `kyroguard_resource_owners` |
| `dialect` | `'pg'`, `'mysql'` or `'sqlite'` |
| `tables` | Barrel object consumed by `drizzleAdapter` |

Column-by-column details are in [Database schema](/reference/database-schema).
