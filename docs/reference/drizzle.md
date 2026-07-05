# Drizzle

Reference for `@kyrobit/rbac/drizzle`. Supports PostgreSQL, MySQL and SQLite with `drizzle-orm` >=0.36.0. Setup walkthrough: [Drizzle](/databases/drizzle).

## drizzleAdapter()

```ts
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'

function drizzleAdapter(db: unknown, options: { schema: DrizzleRbacSchema }): DrizzleStorageAdapter
```

| Parameter | Type | Description |
| --- | --- | --- |
| `db` | `unknown` | A Drizzle database handle for the matching dialect. |
| `options.schema` | `DrizzleRbacSchema` | The whole schema module: `import * as schema from '@kyrobit/rbac/drizzle/schema/pg'`. |

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from '@kyrobit/rbac/drizzle/schema/pg'

const db = drizzle(process.env.DATABASE_URL!)
const adapter = drizzleAdapter(db, { schema })
```

The returned adapter:

- `id`: `'drizzle-pg'`, `'drizzle-mysql'` or `'drizzle-sqlite'`, from the schema's dialect.
- `capabilities`: `{ autoOwnershipTracking: true, queryScoping: true, listFiltering: true }`.
- Does not create tables. Run your Drizzle Kit migrations before `rbac sync`.
- Does not close the connection. You own the connection lifecycle.
- Multi-step writes run in a transaction.
- Throws `UnknownPolicyError` when an assignment names an unsynced policy.

### List filters

The adapter implements `listFilters` for [`filterFor`](/reference/core-api#filterfor). The built-in scopes compile to one correlated EXISTS against `rbac_resource_owners` — no extra round trip, and it composes into any query without disturbing joins or pagination:

```sql
EXISTS (SELECT 1 FROM rbac_resource_owners ro
        WHERE ro.resource_type = 'sale'
          AND ro.resource_id = CAST(sales.id AS text)
          AND ro.owner_id = 'user-id'
          AND ro.relation = 'owner')
```

The correlated id column is the resource's `fields.id` mapping when set, otherwise the registered `table`'s `id` column. A resource with neither fails closed — its lists come back empty. `resource_id` is stored as text, so the id column is cast (`text` on PostgreSQL and SQLite, `char(191)` on MySQL).

## trackedDb()

```ts
import { trackedDb } from '@kyrobit/rbac/drizzle'

function trackedDb<T extends object>(db: T, options: TrackedDbOptions): T & { untracked: T }
```

Wraps your Drizzle database. Inserts into registered resource tables record ownership for the current user; selects on resources that declare `list` come back filtered by the user's grant. `db.untracked` is the raw handle.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `rbac` | `Rbac` | required | Your `createRbac` instance. |
| `resources` | `ResourceDefinition[]` | required | Only resources with a `table` are tracked; only those also declaring `list` are filtered. Other tables pass through. |
| `strictTracking` | `'warn' \| 'error' \| 'off'` | `'warn'` | What to do when an insert's ids cannot be read. |

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { trackedDb } from '@kyrobit/rbac/drizzle'
import { rbac, resources } from './rbac.js'

const rawDb = drizzle(process.env.DATABASE_URL!)

export const db = trackedDb(rawDb, { rbac, resources })
```

### What gets tracked

An insert needs the new row ids. The wrapper reads them from `values()` rows that carry an `id`, or from a `.returning()` result. When no user is set on the request, seeders and jobs for example, the insert runs plainly. Inside a transaction, the ownership row commits together with the insert.

Updates and deletes are not intercepted. Call `rbac.ownership.remove()` when you delete an owned resource.

::: warning
An insert without ids in `values()` and without `.returning()` cannot be attributed. Set `strictTracking: 'error'` in development to catch these paths. Use `db.untracked` where skipping tracking is intentional.
:::

### How selects are filtered

A resource that declares `list` opts its table into [automatic filtering](/guide/scopes#automatic-filtering). `db.select()` and `db.selectDistinct()` with `.from()` on that table resolve the user's decision through [`filterForResource`](/reference/core-api#filterforresource) and apply it: `all` leaves the query untouched, `none` compiles to an impossible `WHERE`, `where` is `AND`ed with your own `.where()`.

Selects run unfiltered with no request subject (seeders, jobs), through `db.untracked`, and while the engine itself is deciding — scope checks, filter halves and resource resolvers see the whole table. Updates, deletes and raw SQL are never intercepted.

## Schema subpaths

```ts
import * as schema from '@kyrobit/rbac/drizzle/schema/pg'     // PostgreSQL
import * as schema from '@kyrobit/rbac/drizzle/schema/mysql'  // MySQL
import * as schema from '@kyrobit/rbac/drizzle/schema/sqlite' // SQLite
```

Each module exports the same names. Pass the whole module to `drizzleAdapter` as `schema`.

| Export | Table |
| --- | --- |
| `rbacPolicies` | `rbac_policies` |
| `rbacPolicyGroups` | `rbac_policy_groups` |
| `rbacPolicyGroupPolicies` | `rbac_policy_group_policies` |
| `rbacUserPolicyGroups` | `rbac_user_policy_groups` |
| `rbacUserPolicies` | `rbac_user_policies` |
| `rbacResourceOwners` | `rbac_resource_owners` |
| `dialect` | `'pg'`, `'mysql'` or `'sqlite'` |
| `tables` | Barrel object consumed by `drizzleAdapter` |

Column-by-column details are in [Database schema](/reference/database-schema).
