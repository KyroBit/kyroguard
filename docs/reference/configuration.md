# Configuration

`rbac.config.ts` tells the [CLI](/reference/cli) where your storage adapter, policy modules and group modules live. Your application never reads it — apps call `createRbac()` directly; the config exists so `rbac sync`, `rbac generate` and `rbac status` can find the same definitions without you re-wiring them per command.

## A complete config

::: code-group

```ts [Drizzle]
// rbac.config.ts
import { defineConfig } from '@kyrobit/rbac'

export default defineConfig({
  // Lazy adapter factory: only db-touching commands (`rbac sync`,
  // `rbac status`) open a connection — `rbac generate` never does, and
  // the CLI itself never imports a database driver.
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

```ts [Prisma]
// rbac.config.ts
import { defineConfig } from '@kyrobit/rbac'

export default defineConfig({
  adapter: async () => {
    const { PrismaClient } = await import('@prisma/client')
    const { prismaAdapter } = await import('@kyrobit/rbac/prisma')
    // Prisma migrations own DDL: include the rbac models (prisma/rbac.prisma)
    // in your schema and run `prisma migrate dev` before `rbac sync`.
    return prismaAdapter(new PrismaClient())
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

```ts [Mongoose]
// rbac.config.ts
import { defineConfig } from '@kyrobit/rbac'

export default defineConfig({
  adapter: async () => {
    const { createConnection } = await import('mongoose')
    const { mongooseAdapter } = await import('@kyrobit/rbac/mongoose')
    const connection = await createConnection(
      process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/app',
    ).asPromise()
    return mongooseAdapter(connection)
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

:::

`rbac init` writes a config in this shape for your detected stack.

## `RbacConfig`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `adapter` | `() => Promise<StorageAdapter> \| StorageAdapter` | yes | Factory returning a connected storage adapter. Called only by `sync` and `status`. |
| `portals` | `PortalConfig[]` | yes | One entry per portal. A single-app setup uses one entry with no `name`. |
| `typegen.output` | `string` | no | Output path for the generated declaration file. Default `'./rbac.d.ts'`. |

### `PortalConfig`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | no | Portal name. Omit (or use `''`) for a portal-less setup — policy names are then stored unqualified. |
| `policies` | `string` | yes | Path to the module exporting your `ResourceDefinition[]`. |
| `groups` | `string` | no | Path to the module exporting your `GroupsDefinition`. When omitted, `sync` skips group seeding for this portal. |

All three paths resolve relative to the config file's directory, not the working directory, so CLI runs from a monorepo root and from the package directory produce identical results.

### Module export conventions

The `policies` module must export a `ResourceDefinition[]` as `resources`, `policies`, or the default export — the first defined one wins, in that order. The `groups` module must export a `GroupsDefinition` object as `groups` or the default export.

```ts
// src/rbac/policies.ts
import { Policy, Scope } from '@kyrobit/rbac'
import type { ResourceDefinition } from '@kyrobit/rbac'

export const resources: ResourceDefinition[] = [
  {
    type: 'post',
    policies: [
      new Policy('posts.read'),
      new Policy('posts.update', 'Update posts', ['posts.read'], [Scope.owned()]),
    ],
  },
]
```

Policy names here are unqualified; `sync` stores them prefixed with the portal name (`admin.posts.read`). See [Defining policies](/guide/defining-policies).

## `defineConfig`

```ts
export function defineConfig(config: RbacConfig): RbacConfig
```

A typed identity function — it returns its argument unchanged and exists so your editor checks and autocompletes the config shape. Using a plain object export works identically at runtime.

## Why the adapter factory is lazy

`adapter` is a function rather than an adapter instance for two reasons:

1. **`rbac generate` must work without a database.** Typegen runs in CI and pre-commit contexts that have no credentials; because the factory is only called by `sync` and `status`, `generate` never opens a connection.
2. **The CLI must not import your driver.** Database drivers and ORMs are imported inside the factory with dynamic `import()`, so evaluating the config file itself stays side-effect free. The CLI has no dependency on `pg`, `mysql2`, `better-sqlite3`, `drizzle-orm`, `@prisma/client` or `mongoose` — your config owns those imports, in your project's dependency tree.

::: warning Keep driver imports inside the factory
A top-level `import { db } from './src/db/index.js'` in `rbac.config.ts` defeats the laziness: the connection module is evaluated on every CLI run, including `rbac generate`. Use `await import(...)` inside `adapter` as in the examples above.
:::

## Config discovery

The CLI resolves the config in this order:

1. `--config <path>` — used as-is (relative paths resolve against the working directory). A missing file is an error: `[rbac] Config file not found: ...`.
2. Otherwise, the first existing file in the working directory among `rbac.config.ts`, `rbac.config.mts`, `rbac.config.mjs`, `rbac.config.js`.
3. Otherwise: ``[rbac] No rbac.config.{ts,mts,mjs,js} found in <cwd> — run `rbac init` or pass --config <path>.`` and exit 1.

Under Node the file is loaded through jiti (TypeScript works without a build step); under Bun it is imported natively.

After loading, the CLI validates the shape and fails with a pointed message when `adapter` is not a function, `portals` is not an array, or any portal lacks a `policies` path.

## Relationship to `createRbac`

The config file configures the CLI only. Your application constructs its own instance:

```ts
import { createRbac } from '@kyrobit/rbac'
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from '@kyrobit/rbac/drizzle/schema/pg'
import { db } from './db/index.js'
import { resources } from './rbac/policies.ts'

export const rbac = createRbac({ adapter: drizzleAdapter(db, { schema }), resources, db })
```

`createRbac` accepts runtime concerns the config file has no notion of — cache, invalidation bus, decision and cache hooks, super-user bypass. See the [Core API reference](/reference/core-api) for the full `CreateRbacOptions` list.

## Next steps

- [CLI](/reference/cli) — what each command reads and writes.
- [Core API](/reference/core-api) — `createRbac` options and the `Rbac` instance surface.
- [Syncing policies](/guide/syncing-policies) — the sync lifecycle end to end.
