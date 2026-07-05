# Prisma

Set up @kyrobit/rbac with Prisma: scaffold with `rbac init` (which writes the rbac models to `prisma/rbac.prisma`), include them in your Prisma schema and migrate with `prisma migrate dev`, wire `prismaAdapter(new PrismaClient())`, and apply `rbacPrismaExtension` for automatic ownership tracking. Works with the `postgresql`, `mysql` and `sqlite` datasource providers.

::: tip Prerequisites
You have a project with `prisma` and `@prisma/client` (v5 or v6) installed and a database Prisma supports, and you have read [Installation](/guide/installation). Policy and group syntax is covered in [Policies](/guide/defining-policies) and [Groups](/guide/organizing-groups) — this page uses the starter files as generated.
:::

## 1. Install the dependencies

```bash
npm install @kyrobit/rbac @prisma/client
npm install -D prisma
```

The package is ESM-only and requires Node >= 20.19 (Bun works too). `@prisma/client` is an optional peer dependency — the core entry point never imports it, and neither does `@kyrobit/rbac/prisma`: the adapter is typed against a structural client contract, so any client generated from the rbac models satisfies it (see the [Prisma reference](/reference/prisma#prismaclientlike)).

## 2. Scaffold with `rbac init`

`rbac init` detects Prisma from `@prisma/client` or `prisma` in your `package.json` (a `drizzle-orm` dependency outranks it — remove stale ORM deps if detection picks the wrong one) and reads the dialect from the `provider` of the `datasource` block in `prisma/schema.prisma`. There is no dialect question — the rbac models are provider-agnostic:

```
$ npx rbac init
[rbac] Detected stack:
  framework: fastify
  orm:       prisma
  dialect:   pg

Framework (fastify/express) [fastify]:
ORM (drizzle/prisma/mongoose) [prisma]:
Portal name [admin]:
  wrote   rbac.config.ts
  wrote   src/rbac/policies.ts
  wrote   src/rbac/groups.ts
  wrote   src/rbac/wiring.ts
  wrote   prisma/rbac.prisma

[rbac] Next steps:
  1. Include prisma/rbac.prisma in your Prisma schema — enable multi-file
     schemas (prismaSchemaFolder) or paste its models into schema.prisma.
  2. Run your migrations (npx prisma migrate dev, or prisma db push).
  3. Finish the TODOs in rbac.config.ts and src/rbac/wiring.ts.
  4. Run `rbac sync`.
```

Pass `--yes` to accept the detected defaults without prompting. Existing files are never overwritten without confirmation.

The model snippet lands in `prisma/rbac.prisma`. One exception: when your project keeps a root-level `schema.prisma` and has no `prisma/` directory, the file is written as `rbac.prisma` next to it instead.

## 3. Include the models in your schema and migrate

`prisma/rbac.prisma` contains the six rbac models. Abbreviated (the full content is also exported as [`prismaSchemaSnippet`](/reference/prisma#prismaschemasnippet)):

```prisma
// @kyrobit/rbac tables — scaffolded by `rbac init`.
// ── @kyrobit/rbac models ─────────────────────────────────────────────────────
// Generated tables interoperate with the Drizzle schema: identical table
// names, snake_case columns, defaults and unique constraints.
// portal / contextId / contextType use the '' sentinel (never NULL).

model RbacPolicy {
  id           String   @id @default(cuid())
  name         String   @unique(map: "rbac_policies_name_unique")
  portal       String   @default("")
  label        String
  scopeOptions Json     @default("[]") @map("scope_options")
  dependsOn    Json     @default("[]") @map("depends_on")
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @default(now()) @map("updated_at")

  groupEntries    RbacPolicyGroupPolicy[]
  userAssignments RbacUserPolicy[]

  @@map("rbac_policies")
}

// ...RbacPolicyGroup and RbacPolicyGroupPolicy...

model RbacUserPolicy {
  id        String   @id @default(cuid())
  subjectId String   @map("subject_id")
  policyId  String   @map("policy_id")
  portal    String   @default("")
  contextId String   @default("") @map("context_id")
  scope     String?
  createdAt DateTime @default(now()) @map("created_at")

  policy RbacPolicy @relation(fields: [policyId], references: [id])

  @@unique([subjectId, policyId, portal, contextId], map: "rbac_up_tuple_uq")
  @@index([subjectId], map: "rbac_up_subject_idx")
  @@map("rbac_user_policies")
}

// ...RbacUserPolicyGroup and RbacResourceOwner...
```

`portal` and `context_id` default to `''`, never `NULL`. The empty string is a sentinel meaning "none": in SQL, `NULL` values never compare equal, so a nullable context column would let the four-column unique constraints admit duplicate assignment rows. With the sentinel, matching is plain equality — a grant with no context can never leak into a request that has one.

Prisma reads a single schema file by default, so the models must reach `schema.prisma` one of two ways:

- **Multi-file schemas.** Prisma merges every `.prisma` file in the schema folder (the `prismaSchemaFolder` preview feature on Prisma 5.x; built in on recent versions). If your schema folder is `prisma/`, the file is already in place; if you use `prisma/schema/`, move `rbac.prisma` in there.
- **Paste in.** Copy the six models from `prisma/rbac.prisma` into `schema.prisma` and delete the scaffolded file.

Then run your normal migration flow (or `npx prisma db push` during development):

```bash
npx prisma migrate dev
```

This creates six tables:

| Table | Purpose |
| --- | --- |
| `rbac_policies` | Policy definitions synced from code |
| `rbac_policy_groups` | Named groups (roles) |
| `rbac_policy_group_policies` | Group → policy membership, with per-entry scope |
| `rbac_user_policy_groups` | Subject → group assignments per portal + context |
| `rbac_user_policies` | Direct subject → policy assignments per portal + context |
| `rbac_resource_owners` | Ownership rows backing `Scope.owned()` |

## 4. Wire the adapter

`rbac init` wrote `rbac.config.ts` with a lazy adapter factory — only database-touching commands (`rbac sync`, `rbac status`) open a connection, and the CLI itself never imports `@prisma/client`:

```ts
// rbac.config.ts
import { defineConfig } from '@kyrobit/rbac'

export default defineConfig({
  adapter: async () => {
    const { PrismaClient } = await import('@prisma/client')
    const { prismaAdapter } = await import('@kyrobit/rbac/prisma')
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

The CLI loads `.env` from the working directory, so the `DATABASE_URL` your datasource block references is picked up.

In your application, construct the same adapter once and hand it to `createRbac`. `prismaAdapter` takes any generated `PrismaClient` whose schema contains the six models — no cast, no generated types imported by the package. The adapter does not manage the client lifecycle; you own `$disconnect()`:

```ts
// src/rbac/instance.ts
import { PrismaClient } from '@prisma/client'
import { createRbac } from '@kyrobit/rbac'
import { prismaAdapter } from '@kyrobit/rbac/prisma'
import { resources } from './policies.js'

export const client = new PrismaClient()
export const adapter = prismaAdapter(client)
export const rbac = createRbac({ adapter, resources })
```

## 5. Sync and verify

Push your policies and groups into the new tables, and generate `rbac.d.ts` for typed policy names:

```
$ npx rbac sync
[rbac] Synced 4 policies.
[rbac] Seeded 2 groups for portal "admin".
[rbac] Wrote /your/project/rbac.d.ts
```

::: warning Migrate before you sync
`rbac sync` writes to `rbac_policies` and friends — it does not create tables. The adapter has no `ensureSchema()`; Prisma migrations own DDL. Run `rbac sync` before migrating and it fails with Prisma's missing-table error (P2021, "The table `rbac_policies` does not exist in the current database") and the CLI's run-your-migrations hint.
:::

Confirm the adapter is wired and the data landed:

```
$ npx rbac status
adapter:      prisma
capabilities: autoOwnershipTracking=true queryScoping=false
policies:     4
groups:       2
```

`queryScoping=false` is expected — see [No automatic query scoping](#no-automatic-query-scoping) below.

## Tracking ownership with `rbacPrismaExtension`

`Scope.owned()` grants like `'posts.update': 'owned'` check `rbac_resource_owners`. Rather than writing those rows by hand, apply `rbacPrismaExtension` with `$extends`: after `create`, `createMany` and `upsert` on registered models, the extension records ownership for the current request's subject through the adapter.

Register each model by its **client delegate key**, case-exact as Prisma generates it (`model BlogPost` → `'blogPost'`):

```prisma
// prisma/schema.prisma — your own model
model Post {
  id       String @id @default(cuid())
  title    String
  authorId String @map("author_id")

  @@map("posts")
}
```

```ts
// src/db/index.ts
import { rbacPrismaExtension } from '@kyrobit/rbac/prisma'
import { adapter, client, rbac } from '../rbac/instance.js'

// Use this handle everywhere your request handlers touch the database.
export const db = client.$extends(
  rbacPrismaExtension({
    rbac: { engine: rbac.engine, adapter },
    resources: [{ type: 'post', model: 'post' }],
  }),
)
```

Inside a request where a guard has resolved the subject:

```ts
const post = await db.post.create({ data: { title, authorId: subject.id } })
// A row now exists in rbac_resource_owners:
// (resource_type: 'post', resource_id: post.id, owner_id: subject.id)
```

How it behaves:

- **`create`** records the created row's `id` from the result.
- **`createMany`** — Prisma returns only `{ count }`, so ids cannot be read back: input rows that carry a client-provided `id` are recorded; rows relying on database-generated ids are not (see the callout below).
- **`upsert`** — Prisma cannot tell whether the row was created or updated, so ownership is recorded idempotently either way (`recordOwnership` upserts on `(resourceType, resourceId, ownerId)`).
- **No subject** (seeders, CLI scripts, background jobs) means a plain query — there is nobody to attribute ownership to, and nothing is recorded.
- **The ownership write is awaited** before the result is returned; a failing write rejects the caller. The resource row itself is already committed by then — Prisma query extensions run outside any implicit transaction.
- **The result must include `id`.** The default selection does; a custom `select` that omits `id` records nothing.

::: danger Extension gaps: paths Prisma cannot report ids for are invisible
These operations record no ownership — call the portable ownership API explicitly on those paths:

- `createMany` rows without a client-provided `id` (database-generated ids come back only as a count),
- `create`/`upsert` with a custom `select` omitting `id`,
- `$executeRaw` / `$queryRaw` / raw SQL of any kind,
- nested writes (creating rows through a relation on another model),
- `createManyAndReturn`, `updateMany` and every other operation.

Deletes are not intercepted either — deleting a row leaves its ownership rows behind, and `isOwner` would keep answering true for rows that no longer exist.

```ts
// After a write the extension cannot see:
await rbac.ownership.record(subject, { type: 'post', id: post.id })

// When you delete an owned resource:
await rbac.ownership.remove({ type: 'post', id })
```
:::

The failure looks like this: a row created via `createMany` with a database-generated id has no `rbac_resource_owners` entry, so when its owner later calls a route guarded by an owned-scope policy, the guard denies with `403`:

::: code-group

```json [Fastify]
{
  "statusCode": 403,
  "code": "RBAC_SCOPE_DENIED",
  "error": "Forbidden",
  "message": "Forbidden"
}
```

```json [Express]
{
  "message": "Forbidden",
  "code": "RBAC_SCOPE_DENIED"
}
```

:::

Fastify serializes the thrown `ScopeDeniedError` through its own error pipeline (which adds `statusCode` and `error`); the Express `errorHandler()` sends the error's `toBody()` shape. All codes are listed in the [error reference](/reference/errors).

## No automatic query scoping

The Prisma adapter reports `queryScoping: false`: there is no Prisma counterpart to the automatic select filtering that `trackedDb` (Drizzle) and `rbacMongoosePlugin` (Mongoose) provide, and a resource's `context` configuration has no effect on Prisma queries.

Row-level restrictions still work — they are enforced at guard time, not at query time. A grant scoped to `'owned'` (or any custom scope) is checked by the guard's resource resolver before the handler runs, identically on every backend; see [Writing scopes](/guide/writing-scopes) and [Protecting routes](/guide/protecting-routes). For list endpoints, where query-time filtering would have narrowed the result set, add the condition to your own `where`:

```ts
// List only the requester's posts:
const posts = await db.post.findMany({ where: { authorId: subject.id } })
```

## Sharing one database with Drizzle

The `@@map` and `@map` attributes pin the exact table names, snake_case column names and named unique/index constraints of the canonical Drizzle schemas, so a Prisma client and a Drizzle client can operate on the same database — both adapters are certified against the same storage contract suite (S1–S20).

One caveat: pick a single migration tool for the rbac tables. `prisma migrate` and `drizzle-kit` diff the same tables differently — Prisma models `DateTime` as `timestamp(3)` on PostgreSQL where the Drizzle schema uses default-precision timestamps, and each tool names foreign-key constraints its own way — so whichever tool did not create the tables keeps proposing no-op changes to them.

## Prisma notes

- **The client contract is structural.** `@kyrobit/rbac/prisma` never imports `@prisma/client` (its concrete types are generated per project); the adapter is typed against the minimal delegate surface it calls, and the S1–S20 contract suite pins its runtime behavior.
- **Assignments are race-safe.** `assignGroup` and `assignPolicy` upsert on the assignment tuple; when two requests race, the loser's unique-constraint error (P2002) is treated as success, or converted into the scope update the upsert carried, so idempotency holds under concurrency.
- **Do not rename the unique inputs.** The adapter addresses rows through the default compound-unique input names (`subjectId_policyId_portal_contextId` and friends) that Prisma derives from the `@@unique` field lists — adding a `name:` argument to those blocks breaks it. See the [reference](/reference/prisma#compound-unique-inputs).
- **Ids are cuid strings** generated client-side by Prisma's `@default(cuid())`, not by the database. Rows inserted outside Prisma (raw SQL, other tools) must supply their own `id`.
- **`scope_options` and `depends_on` are `Json` columns** with a `'[]'` default; the adapter normalizes array and JSON-string forms when reading, so the models validate unchanged on all three providers.

## Next steps

- [Protecting routes](/guide/protecting-routes) — put `portal.requirePolicy()` in front of your handlers.
- [Scopes](/guide/writing-scopes) — how owned-scope checks and custom scopes resolve.
- [Portals & context](/guide/tenant-contexts) — how the `portal` and `context_id` columns isolate tenants.
