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
const teachers = await models.userPolicyGroup.find({ domain: 'teachers' })
```

The document types (`RbacPolicyDoc` and friends) are exported from the same subpath. Field-by-field details are in [Database schema](/reference/database-schema).

## rbacMongoosePlugin()

```ts
import { rbacMongoosePlugin } from '@kyrobit/rbac/mongoose'

function rbacMongoosePlugin(schema: Schema, options: RbacMongoosePluginOptions): void
```

Schema plugin for your own models. It records ownership on save, and filters reads by the grant of the route's guard. Apply it before compiling the model.

| Option | Type | Description |
| --- | --- | --- |
| `rbac` | `Rbac` | Your `createRbac` instance. |
| `type` | `string` | Resource type in the ownership store, for example `'grade'`. |

```ts
import { Schema, model } from 'mongoose'
import { rbacMongoosePlugin } from '@kyrobit/rbac/mongoose'
import { rbac } from './rbac.js'

const gradeSchema = new Schema({ student: String, subject: String, score: Number, schoolId: String })

gradeSchema.plugin(rbacMongoosePlugin, { rbac, type: 'grade' })

export const Grade = model('Grade', gradeSchema)
```

### What the plugin does

- `save` and `insertMany` record ownership for the current user. No user means no ownership row and no error.
- Document `deleteOne` and `findOneAndDelete` remove the document's ownership rows.
- `find`-family queries and `countDocuments` gain [automatic filtering](/guide/scopes#automatic-filtering) when the route's guard activated a decision for `type` ([`storeFilterFor`](/reference/core-api#storefilterfor)): `all` runs untouched, `none` matches nothing (`{ _id: { $in: [] } }`), `where` is `$and`ed with your filter.

Reads run unfiltered when no guard activated a filter for the resource — unguarded routes, seeders, jobs — and while the engine itself is deciding (scope checks and filter halves). `aggregate`, `distinct` and raw collection reads fire no query middleware, so they are never filtered.

::: warning
`Model.updateMany`, `Model.deleteMany`, `Model.bulkWrite` and raw collection calls fire no document middleware. Call `rbac.ownership.record()` and `rbac.ownership.remove()` on those paths. Otherwise stale ownership rows keep passing `Scope.owned()` checks for deleted documents. See [Ownership](/guide/ownership).
:::
