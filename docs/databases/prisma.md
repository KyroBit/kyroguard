# Prisma

Works with the `postgresql`, `mysql` and `sqlite` providers. Setup is five steps: scaffold, add the models, migrate, wire the adapter, sync.

## 1. Scaffold

Run init in your project root:

```bash
npx rbac init
```

It detects Prisma and writes the starter files:

```
[rbac] Detected stack:
  framework: fastify
  orm:       prisma
  dialect:   pg

  wrote   rbac.config.ts
  wrote   src/rbac/policies.ts
  wrote   src/rbac/groups.ts
  wrote   src/rbac/wiring.ts
  wrote   prisma/rbac.prisma
```

`prisma/rbac.prisma` holds the six rbac models. One exception: with a root-level `schema.prisma` and no `prisma/` directory, it lands next to your schema as `rbac.prisma`.

## 2. Add the models to your schema

Prisma has to see the six models. Pick one:

- **Multi-file schemas.** Prisma merges every `.prisma` file in the schema folder. If that folder is `prisma/`, the file is already in place. If you use `prisma/schema/`, move `rbac.prisma` in there.
- **Single file.** Paste the models from `rbac.prisma` into `schema.prisma` and delete the scaffolded file.

## 3. Migrate

```bash
npx prisma migrate dev
```

This creates the six rbac tables. `npx prisma db push` also works during development. Migrate before you sync. `rbac sync` writes rows, it never creates tables.

## 4. Wire the adapter

Pass a `PrismaClient` to `prismaAdapter` and hand the result to `createRbac`:

```ts
// src/rbac/instance.ts
import { PrismaClient } from '@prisma/client'
import { createRbac } from '@kyrobit/rbac'
import { prismaAdapter } from '@kyrobit/rbac/prisma'
import { resources } from './policies.js'

export const client = new PrismaClient()
export const adapter = prismaAdapter(client)
export const rbac = createRbac({ adapter, resources })
```

Any client generated from a schema that includes the rbac models works. You own the client, so call `$disconnect()` on shutdown. `rbac.config.ts` contains the same wiring for the CLI.

## 5. Sync

```bash
npx rbac sync
```

This writes your policies and groups into the rbac tables. It also generates `rbac.d.ts` for typed policy names. Re-run it whenever they change. The CLI loads `.env`, so your `DATABASE_URL` is picked up. Details in [Sync](/guide/sync).

## Track ownership with `rbacPrismaExtension`

Policies with `Scope.owned()` check who created each row. The extension records that for you. Extend your client once and use the extended handle in request handlers:

```ts
// src/db.ts
import { rbacPrismaExtension } from '@kyrobit/rbac/prisma'
import { client, rbac } from './rbac/instance.js'

export const db = client.$extends(
  rbacPrismaExtension({
    rbac,
    resources: [{ type: 'sale', model: 'sale' }],
  }),
)
```

`model` is the client property name, exactly as Prisma generates it. `model StoreSale` becomes `'storeSale'`.

Creating a row now records the current user as its owner:

```ts
const sale = await db.sale.create({ data: { total } })
// the requesting cashier now owns sale.id
```

`createMany` and `upsert` are tracked too. Writes with no logged-in user (seeders, jobs, scripts) record nothing.

::: warning The extension has gaps
It only sees `create`, `createMany` and `upsert` on registered models. It never sees raw SQL, nested writes through a relation, `createMany` rows without an `id` in the data, or a `create` with a custom `select` that omits `id`. Deletes leave ownership records behind. Cover those paths yourself:

```ts
await rbac.ownership.record(user.id, { type: 'sale', id: sale.id })
await rbac.ownership.remove({ type: 'sale', id: sale.id })
```
:::

## Filtering lists

Declare `list` on the resource in `createRbac` and the extension filters reads for you — `findMany`, `findFirst`, `findUnique` and `count` on the registered model come back scoped to each user's grant ([Automatic filtering](/guide/scopes#automatic-filtering)):

```ts
resources: [{ type: 'sale', list: 'sales.view', policies: [/* ... */] }]
```

For raw SQL, aggregations, or a query the extension does not see, ask the grant yourself with [`filterFor`](/reference/core-api#filterfor) and `AND` the answer into your own query:

```ts
const f = await staff.filterFor(req, 'sales.view')
if (f.kind === 'none') return [] // nothing qualifies — skip the query
const sales = await db.sale.findMany({
  where: f.kind === 'all' ? undefined : (f.where as Prisma.SaleWhereInput),
})
```

Built-in scopes answer with an ID-list fragment (`{ id: { in: [...] } }`) — see [List filters](/reference/prisma#list-filters) for the cap and the `idField` registration, and [Filtering lists](/guide/scopes#filtering-lists) for the three answer kinds.

## Next steps

- [Assigning access](/guide/assigning-access) — give users groups and policies.
- [Protecting routes](/guide/protecting-routes) — put guards in front of handlers.
- [Ownership](/guide/ownership) — how owned-scope checks resolve.
- [Prisma reference](/reference/prisma) — every option of `prismaAdapter` and the extension.
