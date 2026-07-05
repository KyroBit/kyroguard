# MongoDB

Works with MongoDB through Mongoose. There are no migrations. Setup is three steps: scaffold, wire the adapter, sync.

## 1. Scaffold

Run init in your project root:

```bash
npx rbac init
```

It detects Mongoose and writes the starter files:

```
[rbac] Detected stack:
  framework: fastify
  orm:       mongoose
  dialect:   not detected

  wrote   rbac.config.ts
  wrote   src/rbac/policies.ts
  wrote   src/rbac/groups.ts
  wrote   src/rbac/wiring.ts
```

There is no schema file to add. The adapter defines its own Mongoose models.

## 2. Wire the adapter

Pass a Mongoose connection to `mongooseAdapter` and hand the result to `createRbac`:

```ts
// src/rbac/instance.ts
import { createConnection } from 'mongoose'
import { createRbac } from '@kyrobit/rbac'
import { mongooseAdapter } from '@kyrobit/rbac/mongoose'
import { resources } from './policies.js'

export const connection = await createConnection(process.env.MONGODB_URI!).asPromise()
export const adapter = mongooseAdapter(connection)
export const rbac = createRbac({ adapter, resources })
```

You own the connection, so close it on shutdown. `rbac.config.ts` contains the same wiring for the CLI.

## 3. Sync

```bash
npx rbac sync
```

Run this before first traffic — it creates the MongoDB indexes. It also writes your policies and groups, and generates `rbac.d.ts` for typed policy names. Re-run it whenever they change. Details in [Sync](/guide/sync).

## Track ownership with `rbacMongoosePlugin`

Policies with `Scope.owned()` check who created each document. The plugin records that for you. Add it to each schema whose documents can be owned:

```ts
// src/models/sale.ts
import { Schema, model } from 'mongoose'
import { rbacMongoosePlugin } from '@kyrobit/rbac/mongoose'
import { rbac } from '../rbac/instance.js'

const saleSchema = new Schema({ total: Number, branchId: String })

saleSchema.plugin(rbacMongoosePlugin, { rbac, type: 'sale' })

export const Sale = model('Sale', saleSchema)
```

Saving a document now records the current user as its owner:

```ts
const sale = await Sale.create({ total, branchId })
// the requesting cashier now owns sale.id
```

`insertMany` is tracked too. Deleting a document with `deleteOne` or `findOneAndDelete` removes its ownership records. Writes with no logged-in user (seeders, jobs, scripts) record nothing.

::: warning Bulk operations skip the plugin
`Model.updateMany`, `Model.deleteMany`, `bulkWrite` and raw collection calls fire no document middleware, so the plugin never sees them. Record or remove ownership yourself on those paths:

```ts
await rbac.ownership.record(user.id, { type: 'sale', id: saleId })
await rbac.ownership.remove({ type: 'sale', id: saleId })
```
:::

The plugin also filters reads. On a route guarded by `requirePolicy`, `find` queries on the model come back scoped to that policy's grant — behind `requirePolicy('sales.view')`, a cashier's `Sale.find()` returns only their own sales. Unguarded reads run unfiltered. See [Automatic filtering](/guide/scopes#automatic-filtering) and the [Mongoose reference](/reference/mongoose).

## Next steps

- [Assigning access](/guide/assigning-access) — give users groups and policies.
- [Protecting routes](/guide/protecting-routes) — put guards in front of handlers.
- [Ownership](/guide/ownership) — how owned-scope checks resolve.
- [Mongoose reference](/reference/mongoose) — every option of `mongooseAdapter` and the plugin.
