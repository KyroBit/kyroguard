# Drizzle

Reference for `@kyrobit/rbac/drizzle` and the schema subpaths. Supports PostgreSQL, MySQL and SQLite via `drizzle-orm` (>=0.36.0 <2). For setup walkthroughs, see [Drizzle + PostgreSQL](/databases/drizzle-postgres), [Drizzle + MySQL](/databases/drizzle-mysql) and [Drizzle + SQLite](/databases/drizzle-sqlite).

## drizzleAdapter()

```ts
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'

function drizzleAdapter(db: unknown, options: DrizzleAdapterOptions): DrizzleStorageAdapter
```

| Parameter | Type | Description |
| --- | --- | --- |
| `db` | `unknown` | A Drizzle database handle for the matching dialect. Untyped by design — the three dialects' database types do not unify statically. |
| `options.schema` | `DrizzleRbacSchema` | The whole schema module: `import * as schema from '@kyrobit/rbac/drizzle/schema/pg'`. |

**Returns** a `DrizzleStorageAdapter`:

- `id`: `'drizzle-pg'`, `'drizzle-mysql'` or `'drizzle-sqlite'`, from `schema.dialect`.
- `capabilities`: `{ autoOwnershipTracking: true, queryScoping: true }`.
- No `ensureSchema()` — migrations own DDL; generate and run them with your Drizzle Kit workflow before syncing.
- No `close()` — the caller owns the connection lifecycle.
- Multi-step mutations (`upsertPolicies`, `deletePolicies`, `setGroupPolicies`, assignments) run inside `db.transaction()`.
- `recordOwnershipWith(executor, entries)` — internal hook for `trackedDb`: writes ownership rows through a specific executor (the surrounding transaction) so they commit atomically with the tracked resource insert.

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from '@kyrobit/rbac/drizzle/schema/pg'

const db = drizzle(process.env.DATABASE_URL!)
const adapter = drizzleAdapter(db, { schema })
```

### Types

```ts
type DrizzleDialect = 'pg' | 'mysql' | 'sqlite'

interface DrizzleRbacTables {
  policies: unknown
  policyGroups: unknown
  policyGroupPolicies: unknown
  userPolicyGroups: unknown
  userPolicies: unknown
  resourceOwners: unknown
}

interface DrizzleRbacSchema {
  dialect: DrizzleDialect
  tables: DrizzleRbacTables
}

interface DrizzleAdapterOptions {
  schema: DrizzleRbacSchema
}

interface DrizzleStorageAdapter extends StorageAdapter {
  recordOwnershipWith(executor: unknown, entries: OwnershipEntry[]): Promise<void>
}
```

## trackedDb()

```ts
import { trackedDb } from '@kyrobit/rbac/drizzle'

function trackedDb<T extends object>(db: T, options: TrackedDbOptions): T & { untracked: T }
```

Wraps a Drizzle database in a proxy so that:

- **inserts** into registered resource tables record ownership rows for the current request subject — atomically with the insert inside transactions,
- **selects** (`select`, `selectDistinct`) on registered resources get portal-configured query scoping,
- **transactions** hand the callback a wrapped `tx` with the same behavior,
- `db.untracked` exposes the raw, unwrapped handle.

`update` and `delete` are intentionally not intercepted — call [`rbac.ownership.remove()`](/reference/core-api#rbac-ownership) when you delete an owned resource.

### TrackedDbOptions

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `rbac` | `{ engine: RbacEngine; adapter: StorageAdapter }` | required | Pass your `Rbac` instance — it satisfies this shape. |
| `resources` | `ResourceDefinition[]` | required | Only resources with a `table` set are registered; inserts and selects on other tables pass through untouched. |
| `queryScopes` | `Record<string, QueryScopeFn>` | `undefined` | Scope name → condition builder for query scoping. Without it, no select is scoped. |
| `strictTracking` | `'warn' \| 'error' \| 'off'` | `'warn'` | What to do when an insert on a registered resource yields no trackable ids: `'warn'` logs once per resource, `'error'` rejects with `MisconfiguredError`, `'off'` skips silently. |

```ts
type QueryScopeFn = (subject: Subject, db: unknown) => unknown
```

Builds a per-request Drizzle condition (`SQL`); return `undefined` to skip scoping for this request.

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { trackedDb } from '@kyrobit/rbac/drizzle'
import { posts } from './schema.js'
import { rbac, resources } from './rbac.js'

const rawDb = drizzle(process.env.DATABASE_URL!)

export const db = trackedDb(rawDb, {
  rbac,
  resources,
  queryScopes: {
    'same-branch': subject => eq(posts.branchId, subject.context_id as string),
  },
})
```

### Ownership tracking behavior

For an insert into a registered resource table, the proxy needs the new row ids. It finds them, in order:

1. From `values()` — every row carries a string or number `id`.
2. From a `.returning()` / `.$returningId()` result — rows with an `id` field.

When neither yields ids, the `strictTracking` setting applies. When no subject is set on the request (seeders, CLI, background jobs), the insert runs plainly — there is nothing to attribute. The ownership write is awaited before the caller's promise resolves; a failed ownership write rejects the insert rather than vanishing.

One-shot overrides set via `rbac.ownership.addExtra()` are consumed here: string values for `resourceType`, `resourceId`, `ownerId`, `contextType`, `contextId` replace the auto-derived fields for the next tracked insert.

::: warning
An insert without ids in `values()` and without `.returning()` cannot be attributed. The default only warns once per resource — set `strictTracking: 'error'` in development to catch these paths, or use `db.untracked` where tracking is intentional to skip.
:::

### Query scoping behavior

A select on a registered resource is scoped when the resource's `context` config — keyed by the **subject's portal** (`resource.context[subject.portal ?? '']`, mapping policy name → scope names) — names scopes present in `queryScopes`. All matching conditions are OR-combined, then AND-ed into your `where()`. No subject on the request, no matching portal key, or no matching scope builders means no scoping. Chained builder methods (`limit`, `orderBy`, joins) keep the scope.

## Schema subpaths

Each dialect module exports the same names; pass the whole module to `drizzleAdapter` as `schema`.

```ts
import * as schema from '@kyrobit/rbac/drizzle/schema/pg'     // PostgreSQL
import * as schema from '@kyrobit/rbac/drizzle/schema/mysql'  // MySQL
import * as schema from '@kyrobit/rbac/drizzle/schema/sqlite' // SQLite
```

| Export | Table name | Description |
| --- | --- | --- |
| `dialect` | — | Dialect const: `'pg'`, `'mysql'` or `'sqlite'`. |
| `rbacPolicies` | `rbac_policies` | Policy definitions (name, portal, label, scope options, dependencies). |
| `rbacPolicyGroups` | `rbac_policy_groups` | Groups (name, label, description, `is_system`, `is_active`). |
| `rbacPolicyGroupPolicies` | `rbac_policy_group_policies` | Group → policy entries with optional scope. |
| `rbacUserPolicyGroups` | `rbac_user_policy_groups` | Subject → group assignments, unique on (subject, group, portal, context). |
| `rbacUserPolicies` | `rbac_user_policies` | Subject → policy direct grants, unique on (subject, policy, portal, context). |
| `rbacResourceOwners` | `rbac_resource_owners` | Ownership rows, unique on (resource type, resource id, owner id). |
| `tables` | — | Barrel object `{ policies, policyGroups, policyGroupPolicies, userPolicyGroups, userPolicies, resourceOwners }` — the shape `drizzleAdapter` consumes. |

Dialect notes:

- **pg** — `text` ids (cuid2 via `createId()`), `jsonb` for `scope_options`/`depends_on`, `timestamp` columns.
- **mysql** — `varchar(191)` ids and key columns (the max indexable utf8mb4 length that keeps 4-column unique keys under InnoDB's 3072-byte index limit), `json` columns.
- **sqlite** — `text` ids, JSON-mode `text` columns, `integer` timestamps in timestamp mode.

Column-by-column DDL is in [Database schema](/reference/database-schema).
