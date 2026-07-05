# Ownership

`Scope.owned()` needs to know who created what. Ownership records answer that:

```ts
await rbac.ownership.isOwner(user.id, { type: 'post', id: '42' })
```

Each record says: this user created this row. The ORM integrations write these records for you on insert. This page shows how to turn that on, and what to do when it cannot see a write.

## Automatic tracking

### Drizzle

Wrap your database with `trackedDb`. Set `table` on each resource so the tracker knows which tables to watch:

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { trackedDb } from '@kyrobit/rbac/drizzle'
import { rbac } from './rbac/instance' // your createRbac() instance
import { posts } from './schema'

export const resources = [
  { type: 'post', table: posts, policies: [/* ... */] },
]

const raw = drizzle(process.env.DATABASE_URL!)
export const db = trackedDb(raw, { rbac, resources })
```

Inserts into a resource table now record the logged-in user as owner. The logged-in user is whoever your portal's `getSubject` returned. Add `.returning()` so the tracker can see generated ids:

```ts
await db.insert(posts).values({ title: 'Hello' }).returning()
```

Use `db.untracked` for writes you do not want attributed.

### Prisma

Extend your client. `model` is the client property name, so `model BlogPost` becomes `'blogPost'`:

```ts
import { rbacPrismaExtension } from '@kyrobit/rbac/prisma'

export const db = prisma.$extends(
  rbacPrismaExtension({
    rbac,
    resources: [{ type: 'post', model: 'post' }],
  }),
)
```

`create`, `createMany` and `upsert` on registered models record ownership.

### Mongoose

Add the plugin to each resource schema, before compiling the model:

```ts
import { rbacMongoosePlugin } from '@kyrobit/rbac/mongoose'

postSchema.plugin(rbacMongoosePlugin, { rbac, type: 'post' })
const Post = mongoose.model('Post', postSchema)
```

`save` and `insertMany` record ownership. Deleting a document through `deleteOne` or `findOneAndDelete` removes its ownership records too.

::: warning What is not tracked
Automatic tracking hooks into the ORM. Writes that bypass those hooks record nothing:

- Raw SQL and raw collection operations, on every backend.
- Drizzle: inserts with no ids in `values()` and no `.returning()`.
- Prisma: `createMany` rows with database-generated ids, nested writes through relations, `updateMany`.
- Mongoose: `updateMany`, `deleteMany`, `bulkWrite`.

For those paths, call `rbac.ownership.record()` yourself.
:::

## The manual API

```ts
// After creating a row outside the tracked path:
await rbac.ownership.record(user.id, { type: 'post', id: post.id })

// Ask the store directly:
const mine = await rbac.ownership.isOwner(user.id, { type: 'post', id: post.id })

// After deleting a row:
await rbac.ownership.remove({ type: 'post', id: post.id })
```

Recording twice is safe. `remove` clears every owner of the row.

## Background jobs

Automatic tracking attributes rows to the logged-in user. Seeders and background jobs have none, so their inserts record nothing. That is usually right. When a job creates rows for a user, call `rbac.ownership.record()` with that user's id.
