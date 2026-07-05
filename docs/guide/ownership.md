# Ownership

`Scope.owned()` needs to know who created what. Ownership records answer that:

```ts
await rbac.ownership.isOwner(user.id, { type: 'sale', id: '42' })
```

Each record says: this user created this row. When a cashier records a sale, the sale is theirs. That is what `Scope.owned()` checks. The ORM integrations write these records for you on insert. This page shows how to turn that on, and what to do when it cannot see a write.

## Automatic tracking

### Drizzle

Wrap your database with `trackedDb`. Set `table` on each resource so the tracker knows which tables to watch:

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { trackedDb } from '@kyrobit/rbac/drizzle'
import { rbac } from './rbac/instance.js' // your createRbac() instance
import { resources } from './rbac/policies.js' // the same list createRbac got

const raw = drizzle(process.env.DATABASE_URL!)
export const db = trackedDb(raw, { rbac, resources })
```

In `policies.ts`, the `sale` resource carries its table:

```ts
{ type: 'sale', table: sales, policies: [/* ... */] }
```

Inserts into a resource table now record the logged-in user as owner. The logged-in user is whoever your domain's `getSubject` returned. Add `.returning()` so the tracker can see generated ids:

```ts
await db.insert(sales).values({ total: 19.99 }).returning()
```

Use `db.untracked` for writes you do not want attributed.

### Prisma

Extend your client. `model` is the client property name, so `model StoreSale` becomes `'storeSale'`:

```ts
import { rbacPrismaExtension } from '@kyrobit/rbac/prisma'

export const db = prisma.$extends(
  rbacPrismaExtension({
    rbac,
    resources: [{ type: 'sale', model: 'sale' }],
  }),
)
```

`create`, `createMany` and `upsert` on registered models record ownership.

### Mongoose

Add the plugin to each resource schema, before compiling the model:

```ts
import { rbacMongoosePlugin } from '@kyrobit/rbac/mongoose'

saleSchema.plugin(rbacMongoosePlugin, { rbac, type: 'sale' })
const Sale = mongoose.model('Sale', saleSchema)
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
await rbac.ownership.record(user.id, { type: 'sale', id: sale.id })

// Ask the store directly:
const mine = await rbac.ownership.isOwner(user.id, { type: 'sale', id: sale.id })

// After deleting a row:
await rbac.ownership.remove({ type: 'sale', id: sale.id })
```

Recording twice is safe. `remove` clears every owner of the row.

## Background jobs

Automatic tracking attributes rows to the logged-in user. Seeders and background jobs have none, so their inserts record nothing. That is usually right. When a job imports sales for a cashier, call `rbac.ownership.record()` with that cashier's id.
