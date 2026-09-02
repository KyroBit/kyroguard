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
  wrote   src/kyroguard/policies/admin.ts
  wrote   src/kyroguard/groups/admin.ts
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

## Filter queries with `scopePlugin`

A [scope](/guide/scopes) narrows what a grant reaches. The plugin is what applies it: add it to each schema whose documents a scope can restrict.

```ts
// src/models/grade.ts
import { Schema, model } from 'mongoose'
import { scopePlugin } from '@kyrobit/kyroguard/mongoose'
import { guard } from '../kyroguard/instance.js'

const gradeSchema = new Schema({
  student: String,
  subject: String,
  score: Number,
  schoolId: String,
  enteredBy: String,
})

gradeSchema.plugin(scopePlugin, { guard, type: 'grade' })

export const Grade = model('Grade', gradeSchema)
```

Write the scope against your own fields:

```ts
const entered = new Scope('entered', 'Entered by the teacher', subject => ({
  where: { enteredBy: subject.id },
}))
```

On a guarded route, a teacher's `Grade.find()` now returns only the grades they entered, and `Grade.updateMany` / `Grade.deleteMany` reach only those documents. Fill `enteredBy` yourself when you create the document — the plugin does not write it.

::: warning Raw collection calls skip the plugin
`bulkWrite` and calls through `Model.collection` fire no middleware, so the plugin never sees them and they run unfiltered. Reach for [`filterFor`](/guide/scopes#when-you-want-the-condition-in-hand) on those paths and merge the condition yourself.
:::

Behavior: [Automatic filtering](/guide/scopes#automatic-filtering). Mongoose specifics: [reference](/reference/mongoose).

## Next steps

- [Assigning access](/guide/assigning-access) — give users groups and policies.
- [Protecting routes](/guide/protecting-routes) — put guards in front of handlers.
- [Ownership](/guide/ownership) — the owner-field pattern behind an "own rows only" scope.
- [Mongoose reference](/reference/mongoose) — every option of `mongooseAdapter` and the plugin.
