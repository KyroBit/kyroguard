# Prisma

Reference for `@kyrobit/rbac/prisma`. Requires `@prisma/client` 5 or 6 and a schema containing the six rbac models. Setup walkthrough: [Prisma](/databases/prisma).

## prismaAdapter()

```ts
import { prismaAdapter } from '@kyrobit/rbac/prisma'

function prismaAdapter(client: PrismaClientLike): StorageAdapter
```

| Parameter | Type | Description |
| --- | --- | --- |
| `client` | `PrismaClientLike` | A generated `PrismaClient` whose schema includes the six rbac models. |

```ts
import { PrismaClient } from '@prisma/client'
import { createRbac } from '@kyrobit/rbac'
import { prismaAdapter } from '@kyrobit/rbac/prisma'

const rbac = createRbac({ adapter: prismaAdapter(new PrismaClient()) })
```

The returned adapter:

- `id`: `'prisma'`.
- `capabilities`: `{ autoOwnershipTracking: true, queryScoping: false, listFiltering: true }`.
- Does not create tables. Run `prisma migrate` before `rbac sync`.
- Does not call `$disconnect()`. You own the client lifecycle.
- Multi-step writes run in `$transaction`. Concurrent duplicate assignments are safe.
- Throws `UnknownPolicyError` when an assignment names an unsynced policy.

The package never imports `@prisma/client`. The `PrismaClientLike` contract is structural, so any client generated from the six models fits without casts.

### List filters

The adapter implements `listFilters` for [`filterFor`](/reference/core-api#filterfor). Prisma's `WhereInput` cannot express an EXISTS against the polymorphic ownership table, so the built-in scopes take the ID-list route: one query against `RbacResourceOwner` for the matching resource ids, returned as

```ts
{ id: { in: ['…', '…'] } }
```

The id field name comes from the resource's `prisma.idField` registration and defaults to `'id'`.

The list is capped at `PRISMA_ID_LIST_CAP` (10,000) ids per filter. Hitting the cap logs a one-time warning and may truncate results — past that ceiling, denormalize an owner column onto the model and ship a two-line custom scope filter instead. `PRISMA_ID_LIST_CAP` is exported from the subpath.

There is no portable "match nothing" predicate in Prisma, so short-circuit `kind: 'none'` to `[]` yourself instead of running the query — see [Filtering lists](/guide/scopes#filtering-lists).

## rbacPrismaExtension()

```ts
import { rbacPrismaExtension } from '@kyrobit/rbac/prisma'

function rbacPrismaExtension(options: RbacPrismaExtensionOptions): RbacPrismaExtension
```

Client extension that records ownership when your app creates rows. Apply it with `client.$extends(...)` and use the extended client in request code.

| Option | Type | Description |
| --- | --- | --- |
| `rbac` | `Rbac` | Your `createRbac` instance. |
| `resources` | `{ type: string; model: string }[]` | Models to track. `type` is the resource type in the ownership store. `model` is the client delegate key, case-exact: `model SaleItem` is `'saleItem'`. |

```ts
import { PrismaClient } from '@prisma/client'
import { rbacPrismaExtension } from '@kyrobit/rbac/prisma'
import { rbac } from './rbac.js'

const client = new PrismaClient()

export const db = client.$extends(
  rbacPrismaExtension({
    rbac,
    resources: [{ type: 'sale', model: 'sale' }],
  }),
)
```

### What gets tracked

- `create` and `upsert` record ownership from the returned row's `id`.
- `createMany` only records rows whose input carries an `id`. Prisma returns just a count, so database-generated ids cannot be read back.
- No user on the request, seeders and jobs for example, means no ownership row and no error.
- A custom `select` that omits `id` records nothing.

::: warning
Raw SQL, nested writes through relations, `createManyAndReturn`, `updateMany` and deletes are not intercepted. Call `rbac.ownership.record()` on those paths, and `rbac.ownership.remove()` when deleting an owned resource. Otherwise stale ownership rows keep passing `Scope.owned()` checks for rows that no longer exist. See [Ownership](/guide/ownership).
:::

## prismaSchemaSnippet

```ts
import { prismaSchemaSnippet } from '@kyrobit/rbac/prisma'

const prismaSchemaSnippet: string
```

The six rbac models as a Prisma schema string. `rbac init` scaffolds `prisma/rbac.prisma` from it. It validates for the `postgresql`, `mysql` and `sqlite` providers.

| Model | Table |
| --- | --- |
| `RbacPolicy` | `rbac_policies` |
| `RbacPolicyGroup` | `rbac_policy_groups` |
| `RbacPolicyGroupPolicy` | `rbac_policy_group_policies` |
| `RbacUserPolicyGroup` | `rbac_user_policy_groups` |
| `RbacUserPolicy` | `rbac_user_policies` |
| `RbacResourceOwner` | `rbac_resource_owners` |

The models map to the same table and column names as the Drizzle schemas. A Prisma client and a Drizzle client can share one database. Column-by-column details are in [Database schema](/reference/database-schema).

## Compound-unique names

The adapter addresses rows through the compound-unique input names Prisma derives from the `@@unique` field lists:

| Model | Client unique input |
| --- | --- |
| `RbacUserPolicyGroup` | `subjectId_policyGroupId_domain_tenantId` |
| `RbacUserPolicy` | `subjectId_policyId_domain_tenantId` |
| `RbacResourceOwner` | `resourceType_resourceId_ownerId_relation` |

**Do not add a `name:` argument to the `@@unique` blocks. Renaming these inputs breaks the adapter.**
