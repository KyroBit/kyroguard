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

```sh [yarn]
yarn add @kyrobit/rbac
```

```sh [bun]
bun add @kyrobit/rbac
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

[rbac] Next steps:
  1. Add src/db/rbac-schema.ts to your drizzle config schema paths.
  2. Run your migrations (drizzle-kit generate && drizzle-kit migrate, or push).
  3. Finish the TODOs in rbac.config.ts and src/rbac/wiring.ts.
  4. Run `rbac sync`.
```

Output shown for Drizzle. Prisma projects get `prisma/rbac.prisma` instead of `src/db/rbac-schema.ts`. MongoDB projects get no schema file at all.

`rbac.config.ts` tells the CLI where your policies live and how to reach your database. `policies.ts` and `groups.ts` are starters. Replace them with your own.

## 3. Create the tables

@kyrobit/rbac stores its data in six tables in your own database.

### Drizzle

`rbac init` wrote the tables to `src/db/rbac-schema.ts`. Add that file to your drizzle-kit schema paths, then migrate:

```sh
npx drizzle-kit generate && npx drizzle-kit migrate
```

Point the adapter at your existing `db` instance:

```ts
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from './db/rbac-schema.js'
import { db } from './db/index.js'

const adapter = drizzleAdapter(db, { schema })
```

Works on PostgreSQL, MySQL and SQLite. Details: [Drizzle](/databases/drizzle).

### Prisma

`rbac init` wrote the models to `prisma/rbac.prisma`. Include that file in your schema, or paste its models into `schema.prisma`. Then migrate:

```sh
npx prisma migrate dev
```

```ts
import { PrismaClient } from '@prisma/client'
import { prismaAdapter } from '@kyrobit/rbac/prisma'

const adapter = prismaAdapter(new PrismaClient())
```

Details: [Prisma](/databases/prisma).

### MongoDB

No migration step. `rbac sync` creates the collections for you.

```ts
import { createConnection } from 'mongoose'
import { mongooseAdapter } from '@kyrobit/rbac/mongoose'

const connection = await createConnection(process.env.MONGODB_URI!).asPromise()
const adapter = mongooseAdapter(connection)
```

Details: [MongoDB](/databases/mongodb).

## 4. Wire your framework

`rbac init` put this wiring in `src/rbac/wiring.ts`. Finish its TODOs, or write it yourself.

### Fastify

```ts
import Fastify from 'fastify'
import { createRbac } from '@kyrobit/rbac'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { resources } from './rbac/policies.js'

const rbac = createRbac({ adapter, resources })

const app = Fastify()
await app.register(rbacFastify(rbac))

const admin = app.rbac.portal('admin', {
  // Return the logged-in user, or null for a 401
  getSubject: async req => lookupSession(req), // your auth
})

app.get('/posts', { preHandler: admin.requirePolicy('posts.read') }, async () => [])

await app.listen({ port: 3000 })
```

Details: [Fastify](/guide/fastify).

### Express

```ts
import express from 'express'
import { createRbac } from '@kyrobit/rbac'
import { rbacExpress } from '@kyrobit/rbac/express'
import { resources } from './rbac/policies.js'

const rbac = createRbac({ adapter, resources })
const { context, portal, errorHandler } = rbacExpress(rbac)

const app = express()
app.use(context()) // before any guard

const admin = portal('admin', {
  // Return the logged-in user, or null for a 401
  getSubject: async req => lookupSession(req), // your auth
})

app.get('/posts', admin.requirePolicy('posts.read'), (req, res) => {
  res.json([])
})

app.use(errorHandler()) // after your routes
app.listen(3000)
```

Details: [Express](/guide/express).

## 5. Sync

Push your policies and groups to the database:

```sh
npx rbac sync
```

```
[rbac] Synced 4 policies.
[rbac] Seeded 2 groups for portal "admin".
[rbac] Wrote /your/project/rbac.d.ts
```

`rbac.d.ts` gives you policy-name autocompletion in guards. Re-run `rbac sync` whenever your policies change. Details: [Sync](/guide/sync).

## 6. Verify

Start your server and hit a guarded route without logging in:

```sh
curl -i localhost:3000/posts
```

```
HTTP/1.1 401 Unauthorized
{"statusCode":401,"code":"RBAC_UNAUTHENTICATED","error":"Unauthorized","message":"Unauthorized"}
```

A 401 means the guard is enforcing. Express bodies look like `{"message":"Unauthorized","code":"RBAC_UNAUTHENTICATED"}`.

Now give a user access: [Assigning access](/guide/assigning-access).
