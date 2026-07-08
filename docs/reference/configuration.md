# Configuration

`kyroguard.config.ts` tells the [CLI](/reference/cli) where your adapter, policies and groups live. Your app never reads it.

```ts
// kyroguard.config.ts
import { defineConfig } from '@kyrobit/kyroguard'

export default defineConfig({
  // Called only by `kyroguard sync` and `kyroguard status`.
  // `kyroguard generate` never opens a database connection.
  adapter: async () => {
    const { drizzleAdapter } = await import('@kyrobit/kyroguard/drizzle')
    const schema = await import('./src/db/kyroguard-schema.js')
    const { db } = await import('./src/db/index.js')
    return drizzleAdapter(db, { schema })
  },
  // One entry per domain. Single-app setups use one entry with no name.
  domains: [
    {
      name: 'teachers', // the teacher portal
      policies: './src/kyroguard/policies.ts',
      groups: './src/kyroguard/groups.ts',
    },
  ],
  // Where `sync` and `generate` write the type declarations.
  typegen: { output: './kyroguard.d.ts' },
})
```

`kyroguard init` writes this file for your stack. The [Prisma](/databases/prisma) and [MongoDB](/databases/mongodb) pages show the adapter factory for those backends.

## Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `adapter` | `() => Promise<StorageAdapter> \| StorageAdapter` | yes | Factory returning a connected adapter. Called only by `sync` and `status`. |
| `domains` | `DomainConfig[]` | yes | One entry per domain. |
| `typegen.output` | `string` | no | Output path for the generated types. Default `'./kyroguard.d.ts'`. |

Each domain entry:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | no | Domain name. Omit for a single-app setup. |
| `policies` | `string` | yes | Path to the module exporting your `ResourceDefinition[]`. |
| `groups` | `string` | no | Path to the module exporting your `GroupsDefinition`. Omit to skip group seeding. |

Paths resolve relative to the config file, not the working directory. `kyroguard sync` gives the same result from any directory.

## Module exports

The `policies` module exports a `ResourceDefinition[]` as `resources`, `policies`, or the default export. The `groups` module exports a `GroupsDefinition` as `groups` or the default export.

```ts
// src/kyroguard/policies.ts
import { Policy, Scope } from '@kyrobit/kyroguard'
import type { ResourceDefinition } from '@kyrobit/kyroguard'

export const resources: ResourceDefinition[] = [
  {
    type: 'grade',
    policies: [
      new Policy('grades.view', { scopeOptions: [Scope.inTenant()] }),
      new Policy('grades.enter', { dependsOn: ['grades.view'] }),
      new Policy('grades.update', { dependsOn: ['grades.view'], scopeOptions: [Scope.owned(), Scope.inTenant()] }),
      new Policy('grades.delete', { dependsOn: ['grades.view'], scopeOptions: [Scope.inTenant()] }),
    ],
  },
]
```

```ts
// src/kyroguard/groups.ts
import type { GroupsDefinition } from '@kyrobit/kyroguard'

export const groups: GroupsDefinition = {
  teacher: {
    label: 'Teacher',
    policies: { 'grades.view': 'in-tenant', 'grades.enter': 'all', 'grades.update': 'owned' },
  },
  coordinator: {
    label: 'Coordinator',
    policies: { 'grades.view': 'in-tenant', 'grades.update': 'in-tenant', 'grades.delete': 'in-tenant' },
  },
}
```

Groups are job titles. A teacher updates only the grades they entered. The coordinator updates any grade in the school. See [Policies](/guide/policies) and [Groups](/guide/groups) for what goes in these files.

## Keep driver imports inside the factory

Use `await import(...)` inside `adapter`, as in the example above. A top-level `import { db } from './src/db/index.js'` would open a connection on every CLI run, including `kyroguard generate`.

## Config discovery

The CLI finds the config in this order:

1. `--config <path>`, if given. A missing file is an error.
2. The first of `kyroguard.config.ts`, `kyroguard.config.mts`, `kyroguard.config.mjs`, `kyroguard.config.js` in the working directory.
3. Otherwise it exits 1 and suggests `kyroguard init`.

## Relationship to createGuard

The config file is for the CLI only. Your app builds its own instance with `createGuard`. See the [Core API](/reference/core-api) for its options.
