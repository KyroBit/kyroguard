# Tracking ownership

In this guide you record who created each resource, so `Scope.owned()` can answer "does this row belong to the requester" at guard time. Drizzle, Prisma and Mongoose apps get this automatically; every other backend uses the portable `rbac.ownership` API.

::: tip Prerequisites
You have policies synced and a guarded route working ([Protecting routes](/guide/protecting-routes)), and you know how scoped grants behave ([Writing scopes](/guide/writing-scopes)).
:::

## Why ownership exists

`Scope.owned()` is the built-in row-level check:

```ts
static owned(name = 'owned', label = 'Owned by the user'): Scope {
  return new Scope(name, label, (subject, resource, ctx) =>
    ctx.adapter.isOwner(subject.id, resource),
  )
}
```

It asks the storage adapter, not your tables. Every adapter — Drizzle (pg/mysql/sqlite), Prisma, Mongoose, and the in-memory test adapter — implements the same ownership store: rows of `(resourceType, resourceId, ownerId, contextType, contextId)`, upserted on `(resourceType, resourceId, ownerId)`. Recording the same owner twice leaves one row, and one resource can have several owners. Because the store is part of the storage contract, a grant like `posts.update` scoped to `owned` behaves identically on every backend.

When a subject holds the scoped grant but does not own the target row, the guard throws `ScopeDeniedError` and the client receives status 403 with:

```json
{ "message": "Forbidden", "code": "RBAC_SCOPE_DENIED" }
```

Express's `errorHandler()` sends exactly this two-field body; Fastify's default error serializer adds `statusCode: 403` and `error: "Forbidden"` alongside `message` and `code`.

None of that works unless ownership rows exist. The rest of this page is about writing them.

## Recording ownership automatically with Drizzle

`trackedDb()` wraps your Drizzle database so inserts into registered resource tables write ownership rows for the current request subject.

1. Register the table on the resource definition. `trackedDb` matches tables by object identity, so pass the same table object you insert into:

```ts
// src/rbac/policies.ts
import { Policy, Scope } from '@kyrobit/rbac'
import type { ResourceDefinition } from '@kyrobit/rbac'
import { posts } from '../db/schema.js'

export const resources: ResourceDefinition[] = [
  {
    type: 'post',
    table: posts, // enables ownership tracking for inserts into `posts`
    policies: [
      new Policy('posts.read'),
      new Policy('posts.create', 'Create posts', ['posts.read']),
      new Policy('posts.update', 'Update posts', ['posts.read'], [Scope.owned()]),
    ],
  },
]
```

2. Wrap the raw database and use the tracked handle everywhere in request code:

```ts
// src/db/index.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { createRbac } from '@kyrobit/rbac'
import { drizzleAdapter, trackedDb } from '@kyrobit/rbac/drizzle'
import * as rbacSchema from '@kyrobit/rbac/drizzle/schema/pg'
import { resources } from '../rbac/policies.js'

const raw = drizzle(process.env.DATABASE_URL!)

export const adapter = drizzleAdapter(raw, { schema: rbacSchema })
export const rbac = createRbac({ adapter, resources })
export const db = trackedDb(raw, { rbac, resources })
```

3. Insert through the tracked handle inside a guarded route:

```ts
app.post(
  '/posts',
  { preHandler: portal.requirePolicy('posts.create') },
  async request => {
    const [post] = await db
      .insert(posts)
      .values({ title: (request.body as { title: string }).title })
      .returning()
    return post
  },
)
```

The insert runs unchanged, and one ownership row is recorded: `resourceType: 'post'`, `resourceId: post.id`, `ownerId` from the request subject, `contextType` from the subject's portal and `contextId` from its `context_id`. A later `PATCH /posts/:id` guarded by `posts.update` with the `owned` scope now passes for this user and returns the `RBAC_SCOPE_DENIED` body above for everyone else.

### What trackedDb intercepts

- **Inserts on registered tables only.** Tables not listed in `resources` (or resources without `table`) pass through untouched.
- **Ids come from your values or from `.returning()`.** If every row in `.values()` carries a string or number `id`, those ids are used. Otherwise the ids are read from the rows returned by `.returning()` (or MySQL's `.$returningId()`).
- **No subject, no tracking.** Seeders, CLI scripts and background jobs run outside a request context; their inserts execute normally and attribute nothing.
- **Transactions are tracked atomically.** `db.transaction(tx => ...)` hands your callback a tracked `tx`, and ownership rows are written through that same transaction — they commit and roll back together with the resource insert:

```ts
await db.transaction(async tx => {
  const [post] = await tx.insert(posts).values({ title }).returning()
  await tx.insert(revisions).values({ postId: post.id, body })
})
// rollback discards the post, the revision, AND the ownership row
```

- **Updates and deletes are not intercepted.** Deleting a row does not delete its ownership records — call `rbac.ownership.remove({ type: 'post', id })` when you delete a resource so `isOwner` cannot keep answering true for rows that no longer exist.

`trackedDb` also applies automatic query scoping to selects on registered resources when you configure `queryScopes` and a resource `context`; see your [database integration page](/databases/drizzle-postgres).

### Choosing a strictTracking mode

When an insert on a registered table yields no trackable ids — no `id` in `.values()` and no `.returning()` — `trackedDb` cannot record ownership. The `strictTracking` option decides what happens:

| Mode | Behavior |
| --- | --- |
| `'warn'` (default) | The insert runs; a warning is logged once per resource type. |
| `'error'` | The insert is rejected with `MisconfiguredError` (`RBAC_MISCONFIGURED`, HTTP 500) before it executes. |
| `'off'` | The insert runs silently; nothing is recorded. |

```ts
export const db = trackedDb(raw, { rbac, resources, strictTracking: 'error' })
```

::: warning Id-less inserts silently skip tracking
Database-generated primary keys (`serial`, `$defaultFn`, Mongo-style defaults) are not present in `.values()`, so an insert without `.returning()` records no ownership — and the owner can no longer pass an `owned`-scoped guard for that row. In the default mode you get this once per resource type:

```
[rbac] Ownership not tracked for "post": no ids in values() and no .returning(). Add .returning(), pass ids in values(), or use db.untracked to silence.
```

Fix it by adding `.returning()`, passing ids in `.values()`, or switching to `strictTracking: 'error'` so the gap fails loudly in development instead of surfacing later as unexpected 403s.
:::

### Bypassing tracking with db.untracked

`db.untracked` is the raw, unwrapped handle — no ownership tracking, no warnings, no query scoping. Use it for imports and maintenance writes that should not be attributed to anyone:

```ts
await db.untracked.insert(posts).values(seedRows)
```

## Recording ownership automatically with Prisma

`rbacPrismaExtension` is a Prisma client extension that does the same job through query hooks.

1. Apply the extension to your client, registering each model by its client delegate key (`model BlogPost` → `'blogPost'`):

```ts
// src/db/index.ts
import { PrismaClient } from '@prisma/client'
import { createRbac } from '@kyrobit/rbac'
import { prismaAdapter, rbacPrismaExtension } from '@kyrobit/rbac/prisma'
import { resources } from '../rbac/policies.js'

const client = new PrismaClient()

export const adapter = prismaAdapter(client)
export const rbac = createRbac({ adapter, resources })

export const db = client.$extends(
  rbacPrismaExtension({
    rbac, // your createRbac() instance — the extension uses its engine and adapter
    resources: [{ type: 'post', model: 'post' }],
  }),
)
```

2. Create rows through the extended client:

- `db.post.create(...)` → ownership recorded from the returned row's `id`
- `db.post.createMany(...)` → recorded for input rows that carry a client-provided `id`
- `db.post.upsert(...)` → recorded idempotently on both the create and update paths

As with Drizzle, a request without a subject records nothing.

::: danger createMany with database-generated ids, raw SQL, nested writes and deletes are invisible
Prisma's `createMany` returns only `{ count }`, so rows relying on database-generated ids record no ownership; `$executeRaw`/`$queryRaw`, nested writes through relations, `createManyAndReturn`, `updateMany` and every other operation are not intercepted at all, and neither are deletes. Record and clean up yourself on those paths:

```ts
// After a write the extension cannot see:
await rbac.ownership.record(subject, { type: 'post', id: post.id })

// When you delete an owned resource:
await rbac.ownership.remove({ type: 'post', id })
```
:::

Prisma has no automatic query scoping (`queryScoping: false`): list endpoints filter with your own `where` clauses, and row-level restrictions are enforced by guard-time scopes. See [Prisma](/databases/prisma) for the full setup.

## Recording ownership automatically with Mongoose

`rbacMongoosePlugin` is a schema plugin that does the same job through Mongoose middleware.

1. Register the plugin on each resource schema:

```ts
// src/models/post.ts
import { Schema, model } from 'mongoose'
import { rbacMongoosePlugin } from '@kyrobit/rbac/mongoose'
import { rbac } from '../db/index.js'

const postSchema = new Schema({ title: String, body: String })

postSchema.plugin(rbacMongoosePlugin, {
  rbac, // your createRbac() instance — the plugin uses its engine and adapter
  type: 'post', // the resourceType recorded in the ownership store
})

export const Post = model('Post', postSchema)
```

2. Create and delete documents through paths that fire document middleware:

- `doc.save()` and `Model.create()` → ownership recorded (`post('save')`)
- `Model.insertMany()` → ownership recorded for every document
- `doc.deleteOne()` (document middleware) and `Model.findOneAndDelete()` / `Model.findByIdAndDelete()` → all ownership rows for the document removed

As with Drizzle, a request without a subject records nothing.

::: danger updateMany, deleteMany, bulkWrite and raw collection ops fire no middleware
Mongoose only runs document middleware for document-level operations. `Model.updateMany`, `Model.deleteMany`, `Model.bulkWrite` and direct `Model.collection.*` calls bypass the plugin entirely — ownership is neither recorded nor cleaned up on those paths. Record it yourself:

```ts
const result = await Post.bulkWrite(
  rows.map(row => ({ insertOne: { document: row } })),
)

for (const id of Object.values(result.insertedIds)) {
  await rbac.ownership.record(subject, { type: 'post', id: String(id) })
}
```

And clean up before a bulk delete:

```ts
const doomed = await Post.find({ archived: true }, { _id: 1 }).lean()
await Post.deleteMany({ archived: true })
for (const doc of doomed) {
  await rbac.ownership.remove({ type: 'post', id: doc._id.toString() })
}
```
:::

## Using the portable ownership API

`rbac.ownership` works on every storage backend because it is a thin layer over the adapter contract. It is the manual counterpart to `trackedDb`, the Prisma extension and the Mongoose plugin — and the only option on a custom adapter without auto-tracking.

```ts
// Record: owner can be the current Subject or a plain id string.
await rbac.ownership.record('user_42', { type: 'post', id: 'p_1' })

// Passing a Subject fills contextType/contextId from its portal and context_id;
// the third argument overrides both explicitly.
await rbac.ownership.record(
  'user_42',
  { type: 'post', id: 'p_1' },
  { portal: 'branch', contextId: 'b_7' },
)

// The same question Scope.owned() asks at guard time:
const owns = await rbac.ownership.isOwner('user_42', { type: 'post', id: 'p_1' })

// Remove EVERY owner row for the resource — call this when the resource is deleted.
await rbac.ownership.remove({ type: 'post', id: 'p_1' })
```

`contextType` and `contextId` are stored for attribution and reporting; `isOwner` matches only on `(ownerId, type, id)`, so ownership is not tenant-filtered — the policy grant already is (grants match portal and context by strict equality, which is what keeps tenant data isolated).

### Overriding the next tracked insert with addExtra

`rbac.ownership.addExtra()` sets one-shot overrides for the next `trackedDb` insert in the current request. String values under the keys `resourceType`, `resourceId`, `ownerId`, `contextType` and `contextId` replace the derived values; the override is consumed by that single insert and then cleared:

```ts
// Attribute the post to the workspace instead of the requesting user:
rbac.ownership.addExtra({ ownerId: workspace.id })
const [post] = await db.insert(posts).values({ title }).returning()
```

It must run inside a request context (it stores into the per-request state that the framework integration opens), so it has no effect in seeders or jobs.

## Next steps

- [Writing scopes](/guide/writing-scopes) — how scoped grants and `Scope.owned()` are evaluated at guard time
- [Caching](/guide/caching) — what is cached (policy maps, never ownership) and how invalidation works
- [Testing your app](/guide/testing-your-app) — seed ownership rows with `memoryAdapter()` and assert the 403 body
