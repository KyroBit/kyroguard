# Mongoose + MongoDB

Set up @kyrobit/rbac on MongoDB with Mongoose: scaffold with `rbac init`, wire `mongooseAdapter(connection)`, create the collections and their unique indexes with `rbac sync`, and register `rbacMongoosePlugin` on each model you want tracked. There is no migration step — `sync` builds the indexes itself.

::: tip Prerequisites
You have a project with `mongoose` (v8) installed and a MongoDB instance to connect to, and you have read [Installation](/guide/installation). Policy and group syntax is covered in [Policies](/guide/defining-policies) and [Groups](/guide/organizing-groups) — this page uses the starter files as generated.
:::

## 1. Install the dependencies

```bash
npm install @kyrobit/rbac mongoose
```

The package is ESM-only and requires Node >= 20.19 (Bun works too). `mongoose` is an optional peer dependency — the core entry point never imports it; only `@kyrobit/rbac/mongoose` does.

## 2. Scaffold with `rbac init`

`rbac init` detects Mongoose from your `package.json`. There is no dialect question and no schema file — models are defined inside the adapter:

```
$ npx rbac init
[rbac] Detected stack:
  framework: fastify
  orm:       mongoose
  dialect:   not detected

Framework (fastify/express) [fastify]:
ORM (drizzle/prisma/mongoose) [mongoose]:
Portal name [admin]:
  wrote   rbac.config.ts
  wrote   src/rbac/policies.ts
  wrote   src/rbac/groups.ts
  wrote   src/rbac/wiring.ts

[rbac] Next steps:
  1. Finish the TODOs in rbac.config.ts and src/rbac/wiring.ts.
  2. Run `rbac sync` (creates the MongoDB indexes via ensureSchema).
```

Pass `--yes` to accept the detected defaults without prompting.

## 3. Wire the connection and adapter

The generated `rbac.config.ts` uses a lazy adapter factory — only database-touching commands (`rbac sync`, `rbac status`) open a connection, and the CLI itself never imports mongoose:

```ts
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

The CLI loads `.env` from the working directory, so `MONGODB_URI` in your `.env` file is picked up.

In your application, use the same construction. `mongooseAdapter` takes a `Connection`, not the global `mongoose` default — its six models are registered on that connection (and reused if already present), so it never collides with your own models, works with multiple connections, and calling it twice on one connection is safe. The adapter does not manage the connection lifecycle; you open and close it:

```ts
// src/db/connection.ts
import { createConnection } from 'mongoose'

export const connection = createConnection(
  process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/app',
)
```

```ts
// src/rbac/instance.ts
import { createRbac } from '@kyrobit/rbac'
import { mongooseAdapter } from '@kyrobit/rbac/mongoose'
import { connection } from '../db/connection.js'
import { resources } from './policies.js'

export const adapter = mongooseAdapter(connection)
export const rbac = createRbac({ adapter, resources })
```

## 4. Sync and verify

`rbac sync` first calls the adapter's `ensureSchema()`, which runs `syncIndexes()` on all six models — this is what creates the collections' indexes — then pushes your policies and groups and writes `rbac.d.ts`:

```
$ npx rbac sync
[rbac] Synced 4 policies.
[rbac] Seeded 2 groups for portal "admin".
[rbac] Wrote /your/project/rbac.d.ts
```

The adapter uses these collections:

| Collection | Documents | Indexes |
| --- | --- | --- |
| `rbacpolicies` | Policy definitions synced from code | `name` unique |
| `rbacpolicygroups` | Named groups (roles) | `name` unique |
| `rbacpolicygrouppolicies` | Group → policy membership, with per-entry scope | `(policyGroupId, policyId)` unique |
| `rbacuserpolicygroups` | Subject → group assignments per portal + context | `(subjectId, policyGroupId, portal, contextId)` unique; `subjectId` |
| `rbacuserpolicies` | Direct subject → policy assignments per portal + context | `(subjectId, policyId, portal, contextId)` unique; `subjectId` |
| `rbacresourceowners` | Ownership documents backing `Scope.owned()` | `(resourceType, resourceId, ownerId)` unique; `(resourceType, resourceId)` |

::: danger Run sync before serving traffic
The unique indexes are not decoration — assignment idempotency depends on them. `assignGroup` and `assignPolicy` upsert on the assignment tuple, and when two requests race to assign the same tuple, the loser's duplicate-key error (code 11000) is treated as success. Without the unique index there is no duplicate-key error, so concurrent assignments can insert duplicate documents that no later `sync` can safely collapse. Run `rbac sync` (or call `adapter.ensureSchema()` at boot) before the first request that assigns anything.
:::

Verify the wiring:

```
$ npx rbac status
adapter:      mongoose
capabilities: autoOwnershipTracking=true queryScoping=true
policies:     4
groups:       2
```

You can also inspect the indexes in `mongosh`: `db.rbacuserpolicies.getIndexes()` should show the four-field unique index.

## Tracking ownership with `rbacMongoosePlugin`

`Scope.owned()` grants like `'posts.update': 'owned'` check `rbacresourceowners`. Register `rbacMongoosePlugin` on each schema whose documents should be owned by their creator. The plugin records ownership on create, removes it on delete, and merges query scoping into finds — per model, via its middleware.

Register the plugin before compiling the model (Mongoose only applies plugins added before `connection.model()` runs):

```ts
// src/models/post.ts
import { Schema } from 'mongoose'
import { rbacMongoosePlugin } from '@kyrobit/rbac/mongoose'
import { connection } from '../db/connection.js'
import { adapter, rbac } from '../rbac/instance.js'

const postSchema = new Schema({
  title: { type: String, required: true },
  authorId: { type: String, required: true },
})

postSchema.plugin(rbacMongoosePlugin, {
  rbac: { engine: rbac.engine, adapter },
  // The resource type recorded in rbacresourceowners.
  type: 'post',
  // Named filter builders for query scoping.
  queryScopes: {
    owned: subject => ({ authorId: subject.id }),
  },
  // portal → policy name → scope names (mirrors ResourceDefinition.context).
  context: {
    admin: { 'posts.read': ['owned'] },
  },
})

export const Post = connection.model('Post', postSchema)
```

What the plugin hooks do:

- **`post('save')` and `post('insertMany')`** record one `rbacresourceowners` document per created document for the current request's subject (`Model.create` fires `save`). With no subject set — seeders, CLI scripts, jobs — nothing is recorded.
- **`post('deleteOne')` (document middleware) and `post('findOneAndDelete')`** remove all ownership documents for the deleted document. `findByIdAndDelete` goes through `findOneAndDelete`, so it is covered.
- **`pre(/^find/)`** merges query scoping into `find`, `findOne`, `findOneAndUpdate` and every other query starting with `find`. For a subject whose portal appears in `context`, the filters built by the named `queryScopes` are `$or`-combined and `$and`-ed into the query's existing filter. Scoping applies to every subject on that portal; a builder that returns the empty filter `{}` matches every document, which lifts the restriction for that subject (for example `subject => subject.is_super ? {} : { authorId: subject.id }`). Requests with no subject query unscoped.

::: danger Middleware gaps: bulk and query-level writes are invisible
`Model.updateMany`, `Model.deleteMany`, `Model.bulkWrite`, `Model.deleteOne` (the query form — the plugin only hooks the document form) and raw `collection.*` operations fire no document middleware. Documents created through them get no ownership records, and documents deleted through them leave stale ownership behind. Call the portable ownership API explicitly on those paths:

```ts
// After a bulk insert:
await rbac.ownership.record(subject, { type: 'post', id: doc._id.toString() })

// After a bulk delete:
await rbac.ownership.remove({ type: 'post', id })
```
:::

The failure looks like this: a document created via `bulkWrite` has no `rbacresourceowners` entry, so when its owner later calls a route guarded by an owned-scope policy, the guard denies with `403`:

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

## Mongoose notes

- **No multi-collection transactions.** Policy deletion during `rbac sync` is best-effort in dependency order: group entries and direct assignments are removed first, policy documents last, so a partial failure never leaves assignments pointing at deleted policies.
- **Ownership writes are idempotent upserts** keyed on `(resourceType, resourceId, ownerId)` — recording the same ownership twice is harmless.
- **`rbacpolicies` and `rbacpolicygroups` carry `createdAt`/`updatedAt`** (Mongoose `timestamps: true`); the assignment and ownership collections do not.
- **Index changes propagate.** `ensureSchema()` uses `syncIndexes()`, which also drops indexes that no longer match the schema definitions — run it as part of deployment, not ad hoc against a database other tools add indexes to.

## Next steps

- [Protecting routes](/guide/protecting-routes) — put `portal.requirePolicy()` in front of your handlers.
- [Scopes](/guide/writing-scopes) — how owned-scope checks and custom scopes resolve.
- [Portals & context](/guide/tenant-contexts) — how `portal` and `contextId` isolate tenants.
