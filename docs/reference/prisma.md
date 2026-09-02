# Prisma

Reference for `@kyrobit/kyroguard/prisma`. Requires `@prisma/client` 5 or 6 and a schema containing the six kyroguard models. Setup walkthrough: [Prisma](/databases/prisma).

## prismaAdapter()

```ts
import { prismaAdapter } from '@kyrobit/kyroguard/prisma'

function prismaAdapter(client: PrismaClientLike): StorageAdapter
```

| Parameter | Type | Description |
| --- | --- | --- |
| `client` | `PrismaClientLike` | A generated `PrismaClient` whose schema includes the six kyroguard models. |

```ts
import { PrismaClient } from '@prisma/client'
import { createGuard } from '@kyrobit/kyroguard'
import { prismaAdapter } from '@kyrobit/kyroguard/prisma'

const guard = createGuard({ adapter: prismaAdapter(new PrismaClient()) })
```

The returned adapter:

- `id`: `'prisma'`.
- `capabilities`: `{ listFiltering: true }`.
- Does not create tables. Run `prisma migrate` before `kyroguard sync`.
- `close()` calls `$disconnect()` on the client. The CLI calls it after `sync`/`status`; call it yourself on shutdown. A disconnected Prisma client reconnects on its next query, so an early `close()` is recoverable.
- Multi-step writes run in `$transaction`. Concurrent duplicate assignments are safe.
- Throws `UnknownPolicyError` when an assignment names an unsynced policy.

The package never imports `@prisma/client`. The `PrismaClientLike` contract is structural, so any client generated from the six models fits without casts.

### Combining fragments

The adapter implements `listFilters` for [`filterFor`](/reference/core-api#filterfor): `or` returns `{ OR: [...] }`. They are used only when a subject holds one policy under two [scopes](/guide/scopes) — the fragments themselves are `WhereInput` objects your scopes return.

Prisma has no portable "match nothing" predicate, so `none()` is not implemented: short-circuit `kind: 'none'` to `[]` yourself instead of running the query — see [When you want the condition in hand](/guide/scopes#when-you-want-the-condition-in-hand).

## scopeExtension()

```ts
import { scopeExtension } from '@kyrobit/kyroguard/prisma'

function scopeExtension(options: ScopeExtensionOptions): ScopeExtension
```

Client extension that records ownership when your app creates rows, and filters reads on registered models by the grant of the route's guard. Apply it with `client.$extends(...)` and use the extended client in request code.

| Option | Type | Description |
| --- | --- | --- |
| `guard` | `Guard` | Your `createGuard` instance. |
| `resources` | `{ type: string; model: string }[]` | Models to track. `type` is the resource type in the ownership store. `model` is the client delegate key, case-exact: `model StudentGrade` is `'studentGrade'`. |

```ts
import { PrismaClient } from '@prisma/client'
import { scopeExtension } from '@kyrobit/kyroguard/prisma'
import { guard } from './kyroguard/domains.js'

const client = new PrismaClient()

export const db = client.$extends(
  scopeExtension({
    guard,
    resources: [{ type: 'grade', model: 'grade' }],
  }),
)
```

### What gets filtered

- `create` and `upsert` record ownership from the returned row's `id`.
- `createMany` only records rows whose input carries an `id`. Prisma returns just a count, so database-generated ids cannot be read back.
- No user on the request, seeders and jobs for example, means no ownership row and no error.
- A custom `select` that omits `id` records nothing.

### What gets filtered

A registered model gets [automatic filtering](/guide/scopes#automatic-filtering) when the route's guard activated a decision for its resource type ([`storeFilterFor`](/reference/core-api#storefilterfor)): `findMany`, `findFirst`, `findUnique` and `count` apply it. `all` runs the query untouched. `none` answers without querying: `[]` from `findMany`, `0` from `count`, `null` from the rest. `where` rides `AND` next to your own conditions — on `findUnique` the unique selector stays at the top level, as Prisma requires.

Queries run unfiltered when no guard activated a filter for the model's resource — unguarded routes, seeders, jobs — and while a scope is building its own fragment. Raw SQL, `aggregate`, `groupBy` and relations loaded through `include` are never intercepted.

::: warning
Filtering covers reads and writes alike: `findMany`, `findFirst`, `findUnique`, `count`, `updateMany`, `deleteMany`, `update` and `delete` all carry the active grant, so a subject cannot write to rows it cannot read. **Creates are not filtered** — an owner or tenant column is yours to fill in the handler. Raw SQL (`$queryRaw`, `$executeRaw`) and nested writes through a relation bypass the extension entirely and run unfiltered; use [`filterFor`](/guide/scopes#when-you-want-the-condition-in-hand) there. See [Ownership](/guide/ownership).
:::

## prismaSchemaSnippet

```ts
import { prismaSchemaSnippet } from '@kyrobit/kyroguard/prisma'

const prismaSchemaSnippet: string
```

The six kyroguard models as a Prisma schema string. `kyroguard init` scaffolds `prisma/kyroguard.prisma` from it. It validates for the `postgresql`, `mysql` and `sqlite` providers.

| Model | Table |
| --- | --- |
| `KyroguardPolicy` | `kyroguard_policies` |
| `KyroguardPolicyGroup` | `kyroguard_policy_groups` |
| `KyroguardPolicyGroupPolicy` | `kyroguard_policy_group_policies` |
| `KyroguardUserPolicyGroup` | `kyroguard_user_policy_groups` |
| `KyroguardUserPolicy` | `kyroguard_user_policies` |

The models map to the same table and column names as the Drizzle schemas. A Prisma client and a Drizzle client can share one database. Column-by-column details are in [Database schema](/reference/database-schema).

## Compound-unique names

The adapter addresses rows through the compound-unique input names Prisma derives from the `@@unique` field lists:

| Model | Client unique input |
| --- | --- |
| `KyroguardUserPolicyGroup` | `subjectId_policyGroupId_domain_tenantId` |
| `KyroguardUserPolicy` | `subjectId_policyId_domain_tenantId` |

**Do not add a `name:` argument to the `@@unique` blocks. Renaming these inputs breaks the adapter.**
