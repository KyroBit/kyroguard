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
- `capabilities`: `{ autoOwnershipTracking: true, queryScoping: true }`.
- Creates its indexes when `rbac sync` runs. No separate migration step.
- Does not close the connection. You own the connection lifecycle.
- Throws `UnknownPolicyError` when an assignment names an unsynced policy.

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
const editors = await models.userPolicyGroup.find({ portal: 'admin' })
```

The document types (`RbacPolicyDoc` and friends) are exported from the same subpath. Field-by-field details are in [Database schema](/reference/database-schema).

## rbacMongoosePlugin()

```ts
import { rbacMongoosePlugin } from '@kyrobit/rbac/mongoose'

function rbacMongoosePlugin(schema: Schema, options: RbacMongoosePluginOptions): void
```

Schema plugin for your own models. It records ownership on save and scopes find queries per portal. Apply it before compiling the model.

| Option | Type | Description |
| --- | --- | --- |
| `rbac` | `Rbac` | Your `createRbac` instance. |
| `type` | `string` | Resource type in the ownership store, for example `'post'`. |
| `queryScopes` | `Record<string, (subject: Subject) => object>` | Scope name to Mongo filter builder. Optional. |
| `context` | `Record<string, Record<string, string[]>>` | Portal to policy name to scope names. Optional. |

```ts
import { Schema, model } from 'mongoose'
import { rbacMongoosePlugin } from '@kyrobit/rbac/mongoose'
import { rbac } from './rbac.js'

const postSchema = new Schema({ title: String, authorId: String, branchId: String })

postSchema.plugin(rbacMongoosePlugin, {
  rbac,
  type: 'post',
  queryScopes: {
    'same-branch': subject => ({ branchId: subject.context_id }),
  },
  context: {
    branch: { 'posts.read': ['same-branch'] },
  },
})

export const Post = model('Post', postSchema)
```

### What the plugin does

- `save` and `insertMany` record ownership for the current user. No user means no ownership row and no error.
- Document `deleteOne` and `findOneAndDelete` remove the document's ownership rows.
- `find` queries gain the scope filters for the user's portal, OR-combined, then AND-ed with your filter. No user or no matching portal means the query runs unscoped. See [Scopes](/guide/scopes).

::: warning
`Model.updateMany`, `Model.deleteMany`, `Model.bulkWrite` and raw collection calls fire no document middleware. Call `rbac.ownership.record()` and `rbac.ownership.remove()` on those paths. Otherwise stale ownership rows keep passing `Scope.owned()` checks for deleted documents. See [Ownership](/guide/ownership).
:::
