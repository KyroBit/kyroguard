# Installation

Six steps: install, scaffold, migrate, wire your framework, sync, verify.

## 1. Install

::: code-group

```sh [npm]
npm install @kyrobit/rbac
```

```sh [pnpm]
pnpm add @kyrobit/rbac
```

:::

::: tip Private registry
The package is published to GitHub Packages. Add this to your project's `.npmrc` before installing:

```
@kyrobit:registry=https://npm.pkg.github.com
```
:::

## 2. Scaffold

```sh
npx rbac init
```

The CLI detects your framework and ORM, asks a few questions, and writes the starter files:

```
  wrote   rbac.config.ts
  wrote   src/rbac/policies.ts
  wrote   src/rbac/groups.ts
  wrote   src/rbac/wiring.ts
  wrote   src/db/rbac-schema.ts
```

Output shown for Drizzle. Prisma projects get `prisma/rbac.prisma` instead of `src/db/rbac-schema.ts`. MongoDB projects get no schema file at all.

`rbac.config.ts` tells the CLI where your policies live and how to reach your database. `policies.ts` and `groups.ts` are starters. Replace them with your own: [Policies](/guide/policies), [Groups](/guide/groups).

## 3. Create the tables

@kyrobit/rbac stores its data in six tables in your own database.

Migrate, then point the adapter at your database. MongoDB skips migration — `rbac sync` creates the collections.

::: code-group

```ts [Drizzle]
// add src/db/rbac-schema.ts to your drizzle-kit schema paths, then:
// npx drizzle-kit generate && npx drizzle-kit migrate
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from './db/rbac-schema.js'
import { db } from './db/index.js'

const adapter = drizzleAdapter(db, { schema })
```

```ts [Prisma]
// include prisma/rbac.prisma in your schema, then:
// npx prisma migrate dev
import { PrismaClient } from '@prisma/client'
import { prismaAdapter } from '@kyrobit/rbac/prisma'

const adapter = prismaAdapter(new PrismaClient())
```

```ts [MongoDB]
import { createConnection } from 'mongoose'
import { mongooseAdapter } from '@kyrobit/rbac/mongoose'

const connection = await createConnection(process.env.MONGODB_URI!).asPromise()
const adapter = mongooseAdapter(connection)
```

:::

Details per database: [Drizzle](/databases/drizzle), [Prisma](/databases/prisma), [MongoDB](/databases/mongodb).

## 4. Wire your framework

`rbac init` put the wiring in `src/rbac/wiring.ts`. Finish its TODOs: pass your adapter to `createRbac`, register it, and guard a first route. The complete setups are [Fastify](/guide/fastify) and [Express](/guide/express).

## 5. Sync

Push your policies and groups to the database:

```sh
npx rbac sync
```

```
[rbac] Synced 5 policies.
[rbac] Seeded 2 groups.
[rbac] Wrote /your/project/rbac.d.ts
```

`rbac.d.ts` gives you policy-name autocompletion in guards. Re-run after every policy change ([Sync](/guide/sync)).

## 6. Verify

Start your server and hit a guarded route without logging in:

```sh
curl -i localhost:3000/sales
```

```
HTTP/1.1 401 Unauthorized
{"statusCode":401,"code":"RBAC_UNAUTHENTICATED","error":"Unauthorized","message":"Unauthorized"}
```

A 401 means the guard is enforcing. Express bodies look like `{"message":"Unauthorized","code":"RBAC_UNAUTHENTICATED"}`.

Now give a user access: [Assigning access](/guide/assigning-access).
