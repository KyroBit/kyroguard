# Mongoose

Reference for `@kyrobit/kyroguard/mongoose`. Requires Mongoose 8. Setup walkthrough: [MongoDB](/databases/mongodb).

## mongooseAdapter()

```ts
import { mongooseAdapter } from '@kyrobit/kyroguard/mongoose'
import type { Connection } from 'mongoose'

function mongooseAdapter(connection: Connection): StorageAdapter
```

| Parameter | Type | Description |
| --- | --- | --- |
| `connection` | `Connection` | A Mongoose connection. Models register on this connection, so two connections in one process stay separate. |

```ts
import mongoose from 'mongoose'
import { createGuard } from '@kyrobit/kyroguard'
import { mongooseAdapter } from '@kyrobit/kyroguard/mongoose'

const connection = await mongoose.createConnection(process.env.MONGO_URL!).asPromise()
const guard = createGuard({ adapter: mongooseAdapter(connection) })
```

The returned adapter:

- `id`: `'mongoose'`.
- `capabilities`: `{ listFiltering: true }`.
- Creates its indexes when `kyroguard sync` runs. No separate migration step.
- `close()` closes the connection. The CLI calls it after `sync`/`status`; call it yourself on shutdown. A closed mongoose connection must be reopened explicitly, so only call it when the connection is done for good.
- Throws `UnknownPolicyError` when an assignment names an unsynced policy.

### Combining fragments

The adapter implements `listFilters` for [`filterFor`](/reference/core-api#filterfor): `or` returns `{ $or: [...] }` and `none` an always-false predicate. They are used only when a subject holds one policy under two [scopes](/guide/scopes) — the fragments themselves are query objects your scopes return.

## kyroguardModels()

```ts
import { kyroguardModels } from '@kyrobit/kyroguard/mongoose'

function kyroguardModels(connection: Connection): KyroguardModels
```

Returns the six kyroguard models for direct queries. Safe to call repeatedly on one connection. `mongooseAdapter()` calls it internally.

| Property | Model name | Collection |
| --- | --- | --- |
| `policy` | `KyroguardPolicy` | `kyroguardpolicies` |
| `policyGroup` | `KyroguardPolicyGroup` | `kyroguardpolicygroups` |
| `policyGroupPolicy` | `KyroguardPolicyGroupPolicy` | `kyroguardpolicygrouppolicies` |
| `userPolicyGroup` | `KyroguardUserPolicyGroup` | `kyroguarduserpolicygroups` |
| `userPolicy` | `KyroguardUserPolicy` | `kyroguarduserpolicies` |

```ts
const models = kyroguardModels(connection)
const teachers = await models.userPolicyGroup.find({ domain: 'teachers' })
```

The document types (`KyroguardPolicyDoc` and friends) are exported from the same subpath. Field-by-field details are in [Database schema](/reference/database-schema).

## scopePlugin()

```ts
import { scopePlugin } from '@kyrobit/kyroguard/mongoose'

function scopePlugin(schema: Schema, options: ScopePluginOptions): void
```

Schema plugin for your own models. It records ownership on save, and filters reads by the grant of the route's guard. Apply it before compiling the model.

| Option | Type | Description |
| --- | --- | --- |
| `guard` | `Guard` | Your `createGuard` instance. |
| `type` | `string` | Resource type in the ownership store, for example `'grade'`. |

```ts
import { Schema, model } from 'mongoose'
import { scopePlugin } from '@kyrobit/kyroguard/mongoose'
import { guard } from './kyroguard/domains.js'

const gradeSchema = new Schema({ student: String, subject: String, score: Number, schoolId: String })

gradeSchema.plugin(scopePlugin, { guard, type: 'grade' })

export const Grade = model('Grade', gradeSchema)
```

### What the plugin does

- `save` and `insertMany` record ownership for the current user. No user means no ownership row and no error.
- Document `deleteOne` and `findOneAndDelete` remove the document's ownership rows.
- `find`-family queries and `countDocuments` gain [automatic filtering](/guide/scopes#automatic-filtering) when the route's guard activated a decision for `type` ([`storeFilterFor`](/reference/core-api#storefilterfor)): `all` runs untouched, `none` matches nothing (`{ _id: { $in: [] } }`), `where` is `$and`ed with your filter.

Queries run unfiltered when no guard activated a filter for the resource — unguarded routes, seeders, jobs — and while a scope is building its own fragment. `aggregate`, `distinct` and raw collection reads fire no query middleware, so they are never filtered.

::: warning
Query filtering covers reads and writes alike — `find*`, `countDocuments`, `update*`, `delete*` and `replaceOne` all carry the active grant, so a subject cannot write to documents it cannot read. **Saves are not filtered** — an owner or tenant field is yours to fill in the handler. `Model.bulkWrite` and raw collection calls fire no query middleware and run unfiltered; use [`filterFor`](/guide/scopes#when-you-want-the-condition-in-hand) there. See [Ownership](/guide/ownership).
:::
