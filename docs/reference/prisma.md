# Prisma

Reference for `@kyrobit/rbac/prisma`. Requires `@prisma/client` ^5 or ^6, with a schema containing the six rbac models from [`prismaSchemaSnippet`](#prismaschemasnippet). For a setup walkthrough, see [Prisma](/databases/prisma).

## prismaAdapter()

```ts
import { prismaAdapter } from '@kyrobit/rbac/prisma'

function prismaAdapter(client: PrismaClientLike): StorageAdapter
```

| Parameter | Type | Description |
| --- | --- | --- |
| `client` | [`PrismaClientLike`](#prismaclientlike) | A generated `PrismaClient` whose schema contains the six rbac models. The contract is structural, so any such client satisfies it without casts. |

**Returns** a `StorageAdapter`:

- `id`: `'prisma'`.
- `capabilities`: `{ autoOwnershipTracking: true, queryScoping: false }` — the extension tracks ownership, but there is no automatic query scoping for Prisma; row-level restrictions are enforced by guard-time scopes.
- No `ensureSchema()` — Prisma migrations (`prisma migrate` / `prisma db push`) own DDL.
- No `close()` — the caller owns the client (`$disconnect()`).
- Multi-step mutations (`upsertPolicies`, `deletePolicies`, `setGroupPolicies`, `addGroupPolicies`) run inside the interactive form of `client.$transaction`.
- **P2002-as-success race semantics**: concurrent assigns on the same tuple can make the loser's `upsert` throw Prisma's unique-constraint error (P2002). `assignGroup` treats it as success; `assignPolicy` converts it into the scope update the upsert would have run; `recordOwnership` treats it as success. Assignment idempotency (S10/S13) therefore holds under concurrency.

**Throws** `UnknownPolicyError` from `assignPolicy` (and from group-entry writes naming unsynced policies).

```ts
import { PrismaClient } from '@prisma/client'
import { createRbac } from '@kyrobit/rbac'
import { prismaAdapter } from '@kyrobit/rbac/prisma'

const rbac = createRbac({ adapter: prismaAdapter(new PrismaClient()) })
```

## rbacPrismaExtension()

```ts
import { rbacPrismaExtension } from '@kyrobit/rbac/prisma'

function rbacPrismaExtension(options: RbacPrismaExtensionOptions): RbacPrismaExtension
```

Prisma client extension for automatic ownership tracking on your **own** models. Apply it with `client.$extends(...)` and use the extended client in request code.

### RbacPrismaExtensionOptions

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `rbac` | `{ engine: RbacEngine; adapter: StorageAdapter }` | required | Pass your `Rbac` instance — it satisfies this shape. |
| `resources` | `RbacPrismaResourceRegistration[]` | required | The models to track. |

```ts
interface RbacPrismaResourceRegistration {
  type: string  // resource type recorded in the ownership store, e.g. 'post'
  model: string // Prisma CLIENT delegate key, case-exact (model BlogPost → 'blogPost')
}
```

### Behavior

- `create` and `upsert` record ownership from the returned row's `id` for the current request subject. `upsert` cannot distinguish create from update, so ownership is recorded idempotently either way.
- `createMany` returns only `{ count }`, so ids cannot be read back: input rows carrying a client-provided `id` are recorded; rows relying on database-generated ids are not.
- No subject set (seeders, jobs) → no-op, no error.
- The ownership write is awaited before the result is returned; a failing write rejects the caller. The resource row is already committed by then — query extensions run outside any implicit transaction.
- The result must include the `id` field (the default selection does); a custom `select` omitting `id` records nothing.

```ts
import { PrismaClient } from '@prisma/client'
import { rbacPrismaExtension } from '@kyrobit/rbac/prisma'
import { adapter, rbac } from './rbac.js'

const client = new PrismaClient()

export const db = client.$extends(
  rbacPrismaExtension({
    rbac,
    resources: [{ type: 'post', model: 'post' }],
  }),
)
```

The extension object is plain structural data (`{ name, query }`). Generated `$extends` signatures are project-specific mapped types; most configurations accept it as-is, but a strict setup that rejects it can cast at the call site — `client.$extends(rbacPrismaExtension({ ... }) as Parameters<typeof client.$extends>[0])`.

::: warning
Not intercepted: `createMany` rows without client-provided ids, `create`/`upsert` with a `select` omitting `id`, `$executeRaw` / `$queryRaw`, nested writes through relations, `createManyAndReturn`, `updateMany`, deletes and every other operation. Call [`rbac.ownership.record()`](/reference/core-api#rbac-ownership) explicitly on those paths, and `rbac.ownership.remove()` when deleting an owned resource — otherwise stale ownership rows keep satisfying `Scope.owned()` checks for rows that no longer exist.
:::

## prismaSchemaSnippet

```ts
import { prismaSchemaSnippet } from '@kyrobit/rbac/prisma'

const prismaSchemaSnippet: string
```

The six rbac model definitions as a Prisma-schema string — the source `rbac init` scaffolds `prisma/rbac.prisma` from. Validates unchanged for the `postgresql`, `mysql` and `sqlite` providers.

| Model | Table (`@@map`) | Purpose |
| --- | --- | --- |
| `RbacPolicy` | `rbac_policies` | Policy definitions (name, portal, label, `scope_options`, `depends_on`). |
| `RbacPolicyGroup` | `rbac_policy_groups` | Groups (name, label, description, `is_system`, `is_active`). |
| `RbacPolicyGroupPolicy` | `rbac_policy_group_policies` | Group → policy entries with optional scope. |
| `RbacUserPolicyGroup` | `rbac_user_policy_groups` | Subject → group assignments per portal + context. |
| `RbacUserPolicy` | `rbac_user_policies` | Subject → policy direct grants per portal + context. |
| `RbacResourceOwner` | `rbac_resource_owners` | Ownership rows backing `Scope.owned()`. |

`@@map` / `@map` pin the exact table names, snake_case column names and named unique/index constraints of the canonical Drizzle schemas, so a Prisma client and a Drizzle client can share one database. Column-by-column DDL is in [Database schema](/reference/database-schema).

## PrismaClientLike

`@prisma/client` is an optional peer dependency whose concrete types are generated per project, so the package never imports it. The adapter is instead typed against a minimal structural surface — exactly the delegates and methods it calls:

```ts
interface PrismaModelDelegateLike {
  findMany(args?: any): Promise<any[]>
  findFirst(args?: any): Promise<any>
  findUnique(args?: any): Promise<any>
  create(args: any): Promise<any>
  createMany(args: any): Promise<any>
  update(args: any): Promise<any>
  updateMany(args: any): Promise<any>
  upsert(args: any): Promise<any>
  deleteMany(args?: any): Promise<any>
}

interface PrismaRbacModelDelegates {
  readonly rbacPolicy: PrismaModelDelegateLike
  readonly rbacPolicyGroup: PrismaModelDelegateLike
  readonly rbacPolicyGroupPolicy: PrismaModelDelegateLike
  readonly rbacUserPolicyGroup: PrismaModelDelegateLike
  readonly rbacUserPolicy: PrismaModelDelegateLike
  readonly rbacResourceOwner: PrismaModelDelegateLike
}

interface PrismaClientLike extends PrismaRbacModelDelegates {
  $transaction<T>(fn: (tx: PrismaRbacModelDelegates) => Promise<T>): Promise<T>
}
```

The delegate property names are fixed by the model names in the snippet (`model RbacPolicy` → client property `rbacPolicy`, and so on); both the root client and the interactive transaction client expose them. The `any`-typed arguments are the module's single deliberate type boundary — Prisma's generated signatures are generic over the exact select shape, which a hand-written structural type cannot capture. The contract test suite (S1–S20) pins the adapter's runtime behavior instead.

## Compound-unique inputs

The adapter addresses assignment and ownership rows through the compound-unique input names Prisma derives from the `@@unique` field lists. The snippet's `map:` arguments rename only the database constraints, so the client inputs keep their defaults:

| Model | Client unique input | Fields |
| --- | --- | --- |
| `RbacUserPolicyGroup` | `subjectId_policyGroupId_portal_contextId` | `subjectId`, `policyGroupId`, `portal`, `contextId` |
| `RbacUserPolicy` | `subjectId_policyId_portal_contextId` | `subjectId`, `policyId`, `portal`, `contextId` |
| `RbacResourceOwner` | `resourceType_resourceId_ownerId` | `resourceType`, `resourceId`, `ownerId` |

`RbacPolicy.name` and `RbacPolicyGroup.name` are single-field `@unique` and are addressed as `where: { name }`. Do not add a `name:` argument to the `@@unique` blocks — that renames the client inputs and breaks the adapter's upserts.
