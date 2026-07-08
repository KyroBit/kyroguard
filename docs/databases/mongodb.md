# MongoDB

Works with MongoDB through Mongoose. There are no migrations. Setup is three steps: scaffold, wire the adapter, sync.

## 1. Scaffold

Run init in your project root:

```bash
npx kyroguard init
```

It detects Mongoose and writes the starter files:

```
[kyroguard] Detected stack:
  framework: fastify
  orm:       mongoose
  dialect:   not detected

  wrote   kyroguard.config.ts
  wrote   src/kyroguard/policies.ts
  wrote   src/kyroguard/groups.ts
  wrote   src/kyroguard/domains.ts
```

There is no schema file to add. The adapter defines its own Mongoose models.

## 2. Wire the adapter

Pass a Mongoose connection to `mongooseAdapter` and hand the result to `createGuard`:

```ts
// src/kyroguard/instance.ts
import { createConnection } from 'mongoose'
import { createGuard } from '@kyrobit/kyroguard'
import { mongooseAdapter } from '@kyrobit/kyroguard/mongoose'
import { resources } from './policies.js'

export const connection = await createConnection(process.env.MONGODB_URI!).asPromise()
export const adapter = mongooseAdapter(connection)
export const guard = createGuard({ adapter, resources })
```

You own the connection at runtime — close it (or call `adapter.close()`, which does the same) on shutdown. `kyroguard.config.ts` contains the same wiring for the CLI, which closes the connection it opened before exiting.

## 3. Sync

```bash
npx kyroguard sync
```

Run this before first traffic — it creates the MongoDB indexes. It also writes your policies and groups, and generates `kyroguard.d.ts` for typed policy names. Re-run it whenever they change. Details in [Sync](/guide/sync).

## Track ownership with `trackingPlugin`

Policies with `Scope.owned()` check who created each document. The plugin records that for you. Add it to each schema whose documents can be owned:

```ts
// src/models/grade.ts
import { Schema, model } from 'mongoose'
import { trackingPlugin } from '@kyrobit/kyroguard/mongoose'
import { guard } from '../kyroguard/instance.js'

const gradeSchema = new Schema({ student: String, subject: String, score: Number, schoolId: String })

gradeSchema.plugin(trackingPlugin, { guard, type: 'grade' })

export const Grade = model('Grade', gradeSchema)
```

Saving a document now records the current user as its owner:

```ts
const grade = await Grade.create({ student, subject, score, schoolId })
// the requesting teacher now owns grade.id
```

`insertMany` is tracked too. Deleting a document with `deleteOne` or `findOneAndDelete` removes its ownership records. Writes with no logged-in user (seeders, jobs, scripts) record nothing.

::: warning Bulk operations skip the plugin
`Model.updateMany`, `Model.deleteMany`, `bulkWrite` and raw collection calls fire no document middleware, so the plugin never sees them. Record or remove ownership yourself on those paths:

```ts
await guard.ownership.record(user.id, { type: 'grade', id: gradeId })
await guard.ownership.remove({ type: 'grade', id: gradeId })
```
:::

The plugin also filters reads: on a guarded route, a teacher's `Grade.find()` returns only the grades they entered. Behavior: [Automatic filtering](/guide/scopes#automatic-filtering). Mongoose specifics: [reference](/reference/mongoose).

## Next steps

- [Assigning access](/guide/assigning-access) — give users groups and policies.
- [Protecting routes](/guide/protecting-routes) — put guards in front of handlers.
- [Ownership](/guide/ownership) — how owned-scope checks resolve.
- [Mongoose reference](/reference/mongoose) — every option of `mongooseAdapter` and the plugin.
