# Mongoose

Reference for `@kyrobit/rbac/mongoose`. Requires Mongoose 8. Setup walkthrough: [MongoDB](/databases/mongodb).

## mongooseAdapter()

```ts
import { mongooseAdapter } from '@kyrobit/rbac/mongoose'
import type { Connection } from 'mongoose'

function mongooseAdapter(connection: Connection): StorageAdapter
```

| Parameter | Type | Description |
| --- | --- | --- |
| `connection` | `Connection` | A Mongoose connection. Models register on this connection, so two connections in one process stay separate. |

```ts
import mongoose from 'mongoose'
import { createRbac } from '@kyrobit/rbac'
import { mongooseAdapter } from '@kyrobit/rbac/mongoose'

const connection = await mongoose.createConnection(process.env.MONGO_URL!).asPromise()
const rbac = createRbac({ adapter: mongooseAdapter(connection) })
```

The returned adapter:

- `id`: `'mongoose'`.
- `capabilities`: `{ autoOwnershipTracking: true, queryScoping: true, listFiltering: true }`.
- Creates its indexes when `rbac sync` runs. No separate migration step.
- Does not close the connection. You own the connection lifecycle.
- Throws `UnknownPolicyError` when an assignment names an unsynced policy.

### List filters

The adapter implements `listFilters` for [`filterFor`](/reference/core-api#filterfor). The built-in scopes take the ID-list route: one `distinct` over the ownership collection for the matching resource ids, returned as

```ts
{ _id: { $in: [/* ids */] } }
```

Ids are cast to `ObjectId` when the resource's registered `table` (its Mongoose model) declares an ObjectId `_id`; string `_id` models get the ids as-is. The list grows with the user's rows for that type — past roughly ten thousand, denormalize an owner field onto the document and ship a custom scope filter instead.

## rbacModels()

```ts
import { rbacModels } from '@kyrobit/rbac/mongoose'

function rbacModels(connection: Connection): RbacModels
```

Returns the six rbac models for direct queries. Safe to call repeatedly on one connection. `mongooseAdapter()` calls it internally.

| Property | Model name | Collection |
| --- | --- | --- |
| `policy` | `RbacPolicy` | `rbacpolicies` |
| `policyGroup` | `RbacPolicyGroup` | `rbacpolicygroups` |
| `policyGroupPolicy` | `RbacPolicyGroupPolicy` | `rbacpolicygrouppolicies` |
| `userPolicyGroup` | `RbacUserPolicyGroup` | `rbacuserpolicygroups` |
| `userPolicy` | `RbacUserPolicy` | `rbacuserpolicies` |
| `resourceOwner` | `RbacResourceOwner` | `rbacresourceowners` |

```ts
const models = rbacModels(connection)
const cashiers = await models.userPolicyGroup.find({ domain: 'branch' })
```

The document types (`RbacPolicyDoc` and friends) are exported from the same subpath. Field-by-field details are in [Database schema](/reference/database-schema).

## rbacMongoosePlugin()

```ts
import { rbacMongoosePlugin } from '@kyrobit/rbac/mongoose'

function rbacMongoosePlugin(schema: Schema, options: RbacMongoosePluginOptions): void
```

Schema plugin for your own models. It records ownership on save. Apply it before compiling the model.

| Option | Type | Description |
| --- | --- | --- |
| `rbac` | `Rbac` | Your `createRbac` instance. |
| `type` | `string` | Resource type in the ownership store, for example `'sale'`. |
| `queryScopes` | `Record<string, (subject: Subject) => object>` | Deprecated find-query scoping. Use [`filterFor`](/reference/core-api#filterfor) instead. |
| `domains` | `Record<string, Record<string, string[]>>` | Deprecated, paired with `queryScopes`. |

```ts
import { Schema, model } from 'mongoose'
import { rbacMongoosePlugin } from '@kyrobit/rbac/mongoose'
import { rbac } from './rbac.js'

const saleSchema = new Schema({ total: Number, cashierId: String, branchId: String })

saleSchema.plugin(rbacMongoosePlugin, { rbac, type: 'sale' })

export const Sale = model('Sale', saleSchema)
```

### What the plugin does

- `save` and `insertMany` record ownership for the current user. No user means no ownership row and no error.
- Document `deleteOne` and `findOneAndDelete` remove the document's ownership rows.

::: warning Deprecated query scoping
With `queryScopes`/`domains` set, `find` queries still gain the scope filters for the user's domain, OR-combined, then AND-ed with your filter — and the plugin logs a one-time deprecation warning. The pre-`find` hook is superseded by [`filterFor`](/reference/core-api#filterfor) and will be removed in the next major; ownership tracking stays. Move each filter builder into the scope's `filter` half — see [Filtering lists](/guide/scopes#filtering-lists).
:::

::: warning
`Model.updateMany`, `Model.deleteMany`, `Model.bulkWrite` and raw collection calls fire no document middleware. Call `rbac.ownership.record()` and `rbac.ownership.remove()` on those paths. Otherwise stale ownership rows keep passing `Scope.owned()` checks for deleted documents. See [Ownership](/guide/ownership).
:::
