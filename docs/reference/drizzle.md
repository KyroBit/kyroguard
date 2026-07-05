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
- `capabilities`: `{ autoOwnershipTracking: true, queryScoping: true }`.
- Does not create tables. Run your Drizzle Kit migrations before `rbac sync`.
- Does not close the connection. You own the connection lifecycle.
- Multi-step writes run in a transaction.
- Throws `UnknownPolicyError` when an assignment names an unsynced policy.

## trackedDb()

```ts
import { trackedDb } from '@kyrobit/rbac/drizzle'

function trackedDb<T extends object>(db: T, options: TrackedDbOptions): T & { untracked: T }
```

Wraps your Drizzle database. Inserts into registered resource tables record ownership for the current user. Selects on registered resources get per-portal query scoping. `db.untracked` is the raw handle.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `rbac` | `Rbac` | required | Your `createRbac` instance. |
| `resources` | `ResourceDefinition[]` | required | Only resources with a `table` are tracked. Other tables pass through. |
| `queryScopes` | `Record<string, QueryScopeFn>` | none | Scope name to condition builder. Without it, no select is scoped. |
| `strictTracking` | `'warn' \| 'error' \| 'off'` | `'warn'` | What to do when an insert's ids cannot be read. |

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

A `QueryScopeFn` builds a Drizzle condition per request:

```ts
type QueryScopeFn = (subject: Subject, db: unknown) => unknown
```

Return `undefined` to skip scoping for that request.

### What gets tracked

An insert needs the new row ids. The wrapper reads them from `values()` rows that carry an `id`, or from a `.returning()` result. When no user is set on the request, seeders and jobs for example, the insert runs plainly. Inside a transaction, the ownership row commits together with the insert.

Updates and deletes are not intercepted. Call `rbac.ownership.remove()` when you delete an owned resource.

::: warning
An insert without ids in `values()` and without `.returning()` cannot be attributed. Set `strictTracking: 'error'` in development to catch these paths. Use `db.untracked` where skipping tracking is intentional.
:::

### How selects are scoped

For a select on a registered resource, the wrapper:

1. Looks up the resource's `context` entry for the user's portal.
2. Collects the scope names it lists that also exist in `queryScopes`.
3. Builds each scope's condition, OR-combines them, and AND-s the result into your `where()`.

No user, no matching portal, or no matching scopes: the select runs unscoped. See [Scopes](/guide/scopes).

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
