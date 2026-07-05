# Mongoose

Reference for `@kyrobit/rbac/mongoose`. Requires Mongoose 8.x. For a setup walkthrough, see [Mongoose](/databases/mongoose).

## mongooseAdapter()

```ts
import { mongooseAdapter } from '@kyrobit/rbac/mongoose'
import type { Connection } from 'mongoose'

function mongooseAdapter(connection: Connection): StorageAdapter
```

| Parameter | Type | Description |
| --- | --- | --- |
| `connection` | `Connection` | A Mongoose connection. Models are registered on this connection, so two connections in one process stay isolated. |

**Returns** a `StorageAdapter`:

- `id`: `'mongoose'`.
- `capabilities`: `{ autoOwnershipTracking: true, queryScoping: true }`.
- `ensureSchema()`: runs `syncIndexes()` on all six RBAC models — `rbac.sync()` and the [`rbac sync` CLI](/reference/cli) call it before writing, so the unique indexes exist without a separate migration step.
- No `close()` — the caller owns the connection lifecycle.
- `deletePolicies` has no multi-collection transaction requirement; it deletes in dependency order (group entries and direct assignments first, policy documents last), so a partial failure never leaves assignments pointing at deleted policies.

**Throws** `UnknownPolicyError` from `assignPolicy` (and from group-entry writes naming unsynced policies).

```ts
import mongoose from 'mongoose'
import { createRbac } from '@kyrobit/rbac'
import { mongooseAdapter } from '@kyrobit/rbac/mongoose'

const connection = await mongoose.createConnection(process.env.MONGO_URL!).asPromise()
const rbac = createRbac({ adapter: mongooseAdapter(connection) })
```

## rbacModels()

```ts
import { rbacModels } from '@kyrobit/rbac/mongoose'

function rbacModels(connection: Connection): RbacModels
```

Connection-scoped model factory — safe to call repeatedly on one connection (it reuses already-registered models instead of re-registering). `mongooseAdapter()` calls it internally; call it yourself for direct queries against the RBAC collections.

```ts
interface RbacModels {
  policy: Model<RbacPolicyDoc>                     // model name 'RbacPolicy'
  policyGroup: Model<RbacPolicyGroupDoc>           // 'RbacPolicyGroup'
  policyGroupPolicy: Model<RbacPolicyGroupPolicyDoc> // 'RbacPolicyGroupPolicy'
  userPolicyGroup: Model<RbacUserPolicyGroupDoc>   // 'RbacUserPolicyGroup'
  userPolicy: Model<RbacUserPolicyDoc>             // 'RbacUserPolicy'
  resourceOwner: Model<RbacResourceOwnerDoc>       // 'RbacResourceOwner'
}
```

### Document types

```ts
interface RbacPolicyDoc {
  name: string
  portal: string
  label: string
  scopeOptions: string[]
  dependsOn: string[]
}

interface RbacPolicyGroupDoc {
  name: string
  label: string
  description: string
  isSystem: boolean
  isActive: boolean
}

interface RbacPolicyGroupPolicyDoc {
  policyGroupId: Types.ObjectId
  policyId: Types.ObjectId
  scope: string | null
}

interface RbacUserPolicyGroupDoc {
  subjectId: string
  policyGroupId: Types.ObjectId
  portal: string
  contextId: string
}

interface RbacUserPolicyDoc {
  subjectId: string
  policyId: Types.ObjectId
  portal: string
  contextId: string
  scope: string | null
}

interface RbacResourceOwnerDoc {
  resourceType: string
  resourceId: string
  ownerId: string
  contextType: string
  contextId: string
}
```

Unique indexes: policy `name`; group `name`; `(policyGroupId, policyId)`; `(subjectId, policyGroupId, portal, contextId)`; `(subjectId, policyId, portal, contextId)`; `(resourceType, resourceId, ownerId)`. `portal`, `contextId` and `contextType` store the `''` sentinel, never null — strict matching stays plain equality and the unique indexes behave identically to the SQL backends.

## rbacMongoosePlugin()

```ts
import { rbacMongoosePlugin } from '@kyrobit/rbac/mongoose'

function rbacMongoosePlugin(schema: Schema, options: RbacMongoosePluginOptions): void
```

Schema plugin for automatic ownership tracking and query scoping on your **own** models. Apply it with `schema.plugin()` before compiling the model.

### RbacMongoosePluginOptions

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `rbac` | `{ engine: RbacEngine; adapter: StorageAdapter }` | required | Pass your `Rbac` instance — it satisfies this shape. |
| `type` | `string` | required | The resource type recorded in the ownership store, e.g. `'post'`. |
| `queryScopes` | `Record<string, (subject: Subject) => Record<string, unknown>>` | `undefined` | Named query-scope builders: scope name → subject → Mongo filter. |
| `context` | `Record<string, Record<string, string[]>>` | `undefined` | Portal → policy name → scope names (mirrors `ResourceDefinition.context`). Keyed by the subject's portal at query time. |

### Behavior

- `post('save')` and `post('insertMany')` record ownership for the current request subject. No subject set (seeders, jobs) → no-op.
- `post('deleteOne')` (document middleware) and `post('findOneAndDelete')` remove all ownership rows for the deleted document.
- `pre(/^find/)` merges the subject's portal query scopes into the query filter: all scope filters named by `context[subject.portal ?? '']` and present in `queryScopes` are `$or`-combined, then `$and`-ed with the existing filter. No subject or no matching portal key → the query runs unscoped.

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

::: warning
`Model.updateMany`, `Model.deleteMany`, `Model.bulkWrite` and raw collection operations fire no document middleware, so ownership is not tracked or cleaned up on those paths. Call [`rbac.ownership.record()`](/reference/core-api#rbac-ownership) / `rbac.ownership.remove()` explicitly there, or stale ownership rows will keep satisfying `Scope.owned()` checks for deleted documents.
:::
