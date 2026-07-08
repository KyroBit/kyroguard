# Prisma

Works with the `postgresql`, `mysql` and `sqlite` providers. Setup is five steps: scaffold, add the models, migrate, wire the adapter, sync.

## 1. Scaffold

Run init in your project root:

```bash
npx kyroguard init
```

It detects Prisma and writes the starter files:

```
[kyroguard] Detected stack:
  framework: fastify
  orm:       prisma
  dialect:   pg

  wrote   kyroguard.config.ts
  wrote   src/kyroguard/policies.ts
  wrote   src/kyroguard/groups.ts
  wrote   src/kyroguard/domains.ts
  wrote   prisma/kyroguard.prisma
```

`prisma/kyroguard.prisma` holds the six kyroguard models. One exception: with a root-level `schema.prisma` and no `prisma/` directory, it lands next to your schema as `kyroguard.prisma`.

## 2. Add the models to your schema

Prisma has to see the six models. Pick one:

- **Multi-file schemas.** Prisma merges every `.prisma` file in the schema folder. If that folder is `prisma/`, the file is already in place. If you use `prisma/schema/`, move `kyroguard.prisma` in there.
- **Single file.** Paste the models from `kyroguard.prisma` into `schema.prisma` and delete the scaffolded file.

## 3. Migrate

```bash
npx prisma migrate dev
```

This creates the six kyroguard tables. `npx prisma db push` also works during development. Migrate before you sync. `kyroguard sync` writes rows, it never creates tables.

## 4. Wire the adapter

Pass a `PrismaClient` to `prismaAdapter` and hand the result to `createKyroguard`:

```ts
// src/kyroguard/instance.ts
import { PrismaClient } from '@prisma/client'
import { createKyroguard } from '@kyrobit/kyroguard'
import { prismaAdapter } from '@kyrobit/kyroguard/prisma'
import { resources } from './policies.js'

export const client = new PrismaClient()
export const adapter = prismaAdapter(client)
export const guard = createKyroguard({ adapter, resources })
```

Any client generated from a schema that includes the kyroguard models works. You own the client at runtime — call `$disconnect()` (or `adapter.close()`, which does the same) on shutdown. `kyroguard.config.ts` contains the same wiring for the CLI, which closes the client it opened before exiting.

## 5. Sync

```bash
npx kyroguard sync
```

This writes your policies and groups into the kyroguard tables. It also generates `kyroguard.d.ts` for typed policy names. Re-run it whenever they change. The CLI loads `.env`, so your `DATABASE_URL` is picked up. Details in [Sync](/guide/sync).

## Track ownership with `kyroguardPrismaExtension`

Policies with `Scope.owned()` check who created each row. The extension records that for you. Extend your client once and use the extended handle in request handlers:

```ts
// src/db.ts
import { kyroguardPrismaExtension } from '@kyrobit/kyroguard/prisma'
import { client, guard } from './kyroguard/instance.js'

export const db = client.$extends(
  kyroguardPrismaExtension({
    guard,
    resources: [{ type: 'grade', model: 'grade' }],
  }),
)
```

`model` is the client property name, exactly as Prisma generates it. `model StudentGrade` becomes `'studentGrade'`.

Creating a row now records the current user as its owner:

```ts
const grade = await db.grade.create({ data: { student, subject, score } })
// the requesting teacher now owns grade.id
```

`createMany` and `upsert` are tracked too. Writes with no logged-in user (seeders, jobs, scripts) record nothing.

::: warning The extension has gaps
It only sees `create`, `createMany` and `upsert` on registered models. It never sees raw SQL, nested writes through a relation, `createMany` rows without an `id` in the data, or a `create` with a custom `select` that omits `id`. Deletes leave ownership records behind. Cover those paths yourself:

```ts
await guard.ownership.record(user.id, { type: 'grade', id: grade.id })
await guard.ownership.remove({ type: 'grade', id: grade.id })
```
:::

## Filtering lists

The extension also filters reads. On a guarded route, a teacher's `db.grade.findMany()` returns only the grades they entered; unguarded reads are not auto-filtered. Behavior and the manual `filterFor` path: [Filtering lists](/guide/scopes#filtering-lists). Prisma specifics — filtered calls, the ID-list fragment and its cap: [Prisma reference](/reference/prisma#what-gets-filtered).

## Next steps

- [Assigning access](/guide/assigning-access) — give users groups and policies.
- [Protecting routes](/guide/protecting-routes) — put guards in front of handlers.
- [Ownership](/guide/ownership) — how owned-scope checks resolve.
- [Prisma reference](/reference/prisma) — every option of `prismaAdapter` and the extension.
