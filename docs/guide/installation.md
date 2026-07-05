# Installation

You set up @kyrobit/rbac end to end: install the package, scaffold config and starter files for your database and framework, migrate, sync your first policies, and verify a guarded route with curl. At the end you have a running server that answers 401, 403 or 200 based on real grants in your database.

::: tip Prerequisites
Read [What is @kyrobit/rbac](/guide/introduction) first if policy, portal, tenant context or scope are new terms. You need Node.js 20.19 or later (or Bun), and a project that already uses Fastify or Express plus Drizzle, Prisma or Mongoose. The package is ESM-only.
:::

## 1. Install the package

The package is published to the GitHub Packages registry under the `@kyrobit` scope, not to npmjs.com. Point the scope at that registry in your project's `.npmrc` — bun, npm and pnpm all read it:

```ini
# .npmrc
@kyrobit:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

GitHub Packages requires authentication even for reads, so set `NODE_AUTH_TOKEN` to a personal access token with the `read:packages` scope. See [GitHub's registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry) for token setup. Then install:

::: code-group

```sh [bun]
bun add @kyrobit/rbac
```

```sh [npm]
npm install @kyrobit/rbac
```

```sh [pnpm]
pnpm add @kyrobit/rbac
```

:::

Fastify/Express and Drizzle/Prisma/Mongoose are optional peer dependencies — the package only imports the ones you use, from its subpaths (`@kyrobit/rbac/fastify`, `@kyrobit/rbac/drizzle`, and so on).

## 2. Scaffold with `rbac init`

`rbac init` detects your stack from `package.json` (and your `drizzle.config.*` for the SQL dialect), asks you to confirm, and writes the starter files. Pass `--yes` to accept the detected defaults without prompts.

::: code-group

```console [Drizzle + PostgreSQL]
$ npx rbac init
[rbac] Detected stack:
  framework: fastify
  orm:       drizzle
  dialect:   pg

Framework (fastify/express) [fastify]:
ORM (drizzle/prisma/mongoose) [drizzle]:
Dialect (pg/mysql/sqlite) [pg]:
Portal name [admin]:
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

```console [Drizzle + MySQL]
$ npx rbac init
[rbac] Detected stack:
  framework: fastify
  orm:       drizzle
  dialect:   mysql

Framework (fastify/express) [fastify]:
ORM (drizzle/prisma/mongoose) [drizzle]:
Dialect (pg/mysql/sqlite) [mysql]:
Portal name [admin]:
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

```console [Drizzle + SQLite]
$ npx rbac init
[rbac] Detected stack:
  framework: fastify
  orm:       drizzle
  dialect:   sqlite

Framework (fastify/express) [fastify]:
ORM (drizzle/prisma/mongoose) [drizzle]:
Dialect (pg/mysql/sqlite) [sqlite]:
Portal name [admin]:
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

```console [Prisma]
$ npx rbac init
[rbac] Detected stack:
  framework: fastify
  orm:       prisma
  dialect:   pg

Framework (fastify/express) [fastify]:
ORM (drizzle/prisma/mongoose) [prisma]:
Portal name [admin]:
  wrote   rbac.config.ts
  wrote   src/rbac/policies.ts
  wrote   src/rbac/groups.ts
  wrote   src/rbac/wiring.ts
  wrote   prisma/rbac.prisma

[rbac] Next steps:
  1. Include prisma/rbac.prisma in your Prisma schema — enable multi-file
     schemas (prismaSchemaFolder) or paste its models into schema.prisma.
  2. Run your migrations (npx prisma migrate dev, or prisma db push).
  3. Finish the TODOs in rbac.config.ts and src/rbac/wiring.ts.
  4. Run `rbac sync`.
```

```console [Mongoose]
$ npx rbac init
[rbac] Detected stack:
  framework: fastify
  orm:       mongoose
  dialect:   not detected

Framework (fastify/express) [fastify]:
ORM (drizzle/prisma/mongoose) [mongoose]:
Portal name [admin]:
  wrote   rbac.config.ts
  wrote   src/rbac/policies.ts
  wrote   src/rbac/groups.ts
  wrote   src/rbac/wiring.ts

[rbac] Next steps:
  1. Finish the TODOs in rbac.config.ts and src/rbac/wiring.ts.
  2. Run `rbac sync` (creates the MongoDB indexes via ensureSchema).
```

:::

What each file is:

| File | Purpose |
| --- | --- |
| `rbac.config.ts` | CLI configuration: a lazy adapter factory (only database-touching commands open a connection), the portal list with paths to your policy and group modules, and the typegen output path. |
| `src/rbac/policies.ts` | Starter `ResourceDefinition[]` — the source of truth for your policy catalog. |
| `src/rbac/groups.ts` | Starter `GroupsDefinition` — the roles `rbac sync` seeds. |
| `src/rbac/wiring.ts` | Framework wiring: creates the rbac instance, registers the integration and defines your portal. Contains the `getSubject` TODO you finish in step 6. |
| `src/db/rbac-schema.ts` | Drizzle only — the six rbac tables (`rbac_policies`, `rbac_policy_groups`, `rbac_policy_group_policies`, `rbac_user_policy_groups`, `rbac_user_policies`, `rbac_resource_owners`) as a Drizzle schema for your migrations. It mirrors `@kyrobit/rbac/drizzle/schema/{pg,mysql,sqlite}` but lives in your repo so drizzle-kit can version it. |
| `prisma/rbac.prisma` | Prisma only — the same six tables as Prisma models, `@@map`-pinned to the same names. Include it via multi-file schemas or paste the models into `schema.prisma`. Written as `rbac.prisma` next to a root-level `schema.prisma` when there is no `prisma/` directory. |

Existing files are never overwritten without a prompt; with `--yes` they are skipped.

## 3. Run the migrations

::: code-group

```ts [Drizzle + PostgreSQL]
// drizzle.config.ts — add the rbac schema file to your schema paths
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/db/schema.ts', './src/db/rbac-schema.ts'], // [!code ++]
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

```ts [Drizzle + MySQL]
// drizzle.config.ts — add the rbac schema file to your schema paths
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'mysql',
  schema: ['./src/db/schema.ts', './src/db/rbac-schema.ts'], // [!code ++]
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

```ts [Drizzle + SQLite]
// drizzle.config.ts — add the rbac schema file to your schema paths
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: ['./src/db/schema.ts', './src/db/rbac-schema.ts'], // [!code ++]
  out: './drizzle',
  dbCredentials: { url: 'file:./data.db' },
})
```

```sh [Prisma]
# Include prisma/rbac.prisma in your schema first: with multi-file schemas
# it is picked up alongside schema.prisma; otherwise paste its models into
# prisma/schema.prisma. Then:
npx prisma migrate dev
```

```txt [Mongoose]
No migration step. MongoDB collections are created on first write, and
`rbac sync` calls the adapter's ensureSchema(), which builds the indexes
for all six rbac collections via syncIndexes(). Continue to step 4.
```

:::

For the Drizzle stacks, generate and apply the migration:

```sh
npx drizzle-kit generate
npx drizzle-kit migrate
```

(`npx drizzle-kit push` works too if you push schemas directly during development.)

## 4. Review the starter policies

`rbac init` wrote a working policy catalog — adjust it before syncing. Policy names here are unqualified; `rbac sync` prefixes them with the portal name (`admin.posts.read`), so the same file can be reused under different portals.

```ts
// src/rbac/policies.ts
import { Policy, Scope } from '@kyrobit/rbac'
import type { ResourceDefinition } from '@kyrobit/rbac'

// Starter resource — replace with your own, then run `rbac sync`.
// Policy names are UNQUALIFIED: the portal prefix is added automatically.
export const resources: ResourceDefinition[] = [
  {
    type: 'post',
    // table: posts, // link your Drizzle table / Mongoose model to enable
    //               // ownership auto-tracking and query scoping
    policies: [
      new Policy('posts.read'),
      new Policy('posts.create', 'Create posts', ['posts.read']),
      new Policy('posts.update', 'Update posts', ['posts.read'], [Scope.owned()]),
      new Policy('posts.delete', 'Delete posts', ['posts.read'], [Scope.owned()]),
    ],
  },
]
```

The `Policy` constructor takes `(name, label?, dependsOn?, scopeOptions?)`. `dependsOn` lists policies that anyone holding this one also needs — sync back-fills them into groups. `scopeOptions` declares which row-level scopes a grant of this policy may carry; `Scope.owned()` is the built-in ownership check.

```ts
// src/rbac/groups.ts
import type { GroupsDefinition } from '@kyrobit/rbac'

// Seeded by `rbac sync` (replace-all per group). Policy names are UNQUALIFIED —
// the portal prefix is added automatically. Scope values: null = unrestricted,
// 'owned' = only rows the subject owns.
export const groups: GroupsDefinition = {
  admin: {
    label: 'Administrator',
    isSystem: true,
    policies: 'all',
  },
  editor: {
    label: 'Editor',
    policies: {
      'posts.read': null,
      'posts.create': null,
      'posts.update': 'owned',
      'posts.delete': 'owned',
    },
  },
}
```

`policies: 'all'` means every policy in the catalog, unrestricted. A record maps each policy to a scope: `null` grants it without restriction, `'owned'` restricts it to rows the subject owns.

Also finish the adapter TODO in `rbac.config.ts` — for Drizzle it imports your db handle, which you create in step 6:

```ts
// rbac.config.ts (Drizzle variant, as generated)
adapter: async () => {
  const { drizzleAdapter } = await import('@kyrobit/rbac/drizzle')
  const schema = await import('./src/db/rbac-schema.js')
  const { db } = await import('./src/db/index.js') // your drizzle instance
  return drizzleAdapter(db, { schema })
},
```

## 5. Sync your policies

`rbac sync` upserts the catalog into storage, deletes policies that no longer exist in code (for this portal only), seeds the groups, and writes `rbac.d.ts`:

::: code-group

```console [npm]
$ npx rbac sync
[rbac] Synced 4 policies.
[rbac] Seeded 2 groups for portal "admin".
[rbac] Wrote /home/you/your-app/rbac.d.ts
```

```console [bun]
$ bunx rbac sync
[rbac] Synced 4 policies.
[rbac] Seeded 2 groups for portal "admin".
[rbac] Wrote /home/you/your-app/rbac.d.ts
```

:::

`rbac.d.ts` augments the package's `RbacTypes` interface, so portal names and per-portal policy names autocomplete and typo-check across your codebase:

```ts
// Generated by `rbac sync` / `rbac generate` — do not edit.

export {}

declare module '@kyrobit/rbac' {
  interface RbacTypes {
    Portal: "admin"
    PolicyName: "posts.create" | "posts.delete" | "posts.read" | "posts.update"
    PortalPolicies: {
      "admin": "posts.create" | "posts.delete" | "posts.read" | "posts.update"
    }
  }
}
```

If your `tsconfig.json` uses an explicit `include`, add `rbac.d.ts` to it. See [TypeScript](/guide/typescript) for how the augmentation works.

If you skipped the migrations, sync fails and tells you (PostgreSQL shown; the first line carries your driver's message):

```console
$ npx rbac sync
[rbac] sync failed: relation "rbac_policies" does not exist
[rbac] The rbac tables do not exist yet — run your migrations first (drizzle-kit push / migrate).
```

::: warning Sync deletes what code no longer defines
Your policy files are the source of truth: a policy removed from code is deleted from storage on the next sync, and the delete cascades into group entries and user assignments. Renaming a policy is a delete plus a create — existing grants of the old name are gone. That is deliberate (stale policies must not remain grantable), so treat renames as a migration: add the new name, move grants over, then remove the old name. Sync only touches the portal it is syncing, and an empty policy list returns early rather than wiping a portal. See [Syncing policies](/guide/syncing-policies).
:::

## 6. Mount your framework

First create the db handle and adapter your app shares (the same construction `rbac.config.ts` uses):

::: code-group

```ts [Drizzle + PostgreSQL]
// src/db/index.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from './rbac-schema.js'

export const db = drizzle({ client: new Pool({ connectionString: process.env.DATABASE_URL }) })
export const adapter = drizzleAdapter(db, { schema })
```

```ts [Drizzle + MySQL]
// src/db/index.ts
import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from './rbac-schema.js'

export const db = drizzle({ client: mysql.createPool(process.env.DATABASE_URL!) })
export const adapter = drizzleAdapter(db, { schema })
```

```ts [Drizzle + SQLite]
// src/db/index.ts
import { drizzle } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from './rbac-schema.js'

export const db = drizzle({ client: new Database('data.db') })
export const adapter = drizzleAdapter(db, { schema })
```

```ts [Prisma]
// src/db/index.ts
import { PrismaClient } from '@prisma/client'
import { prismaAdapter } from '@kyrobit/rbac/prisma'

export const client = new PrismaClient()
export const adapter = prismaAdapter(client)
```

```ts [Mongoose]
// src/db/index.ts
import { createConnection } from 'mongoose'
import { mongooseAdapter } from '@kyrobit/rbac/mongoose'

export const connection = await createConnection(process.env.MONGODB_URI!).asPromise()
export const adapter = mongooseAdapter(connection)
```

:::

Then finish `src/rbac/wiring.ts`. The only TODO is `getSubject` — how a request becomes a subject. The version below reads an `x-user-id` header so you can verify the flow with curl in step 7; replace it with your session or JWT lookup before anything real (see [Resolving the subject](/guide/resolving-the-subject)).

::: code-group

```ts [Fastify]
// src/rbac/wiring.ts
import { createRbac } from '@kyrobit/rbac'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { resources } from './policies.js'
import type { StorageAdapter } from '@kyrobit/rbac'
import type { FastifyInstance } from 'fastify'

export async function registerRbac(app: FastifyInstance, adapter: StorageAdapter) {
  const rbac = createRbac({ adapter, resources })

  await app.register(rbacFastify(rbac))

  const portal = app.rbac.portal('admin', {
    // Resolved lazily at guard time, memoized per request per portal.
    // Return null when the request is unauthenticated → 401.
    getSubject: async request => {
      // Verification only — replace with your session/JWT lookup.
      const id = request.headers['x-user-id']
      return typeof id === 'string' && id !== '' ? { id } : null
    },
  })

  app.get(
    '/posts',
    { preHandler: portal.requirePolicy('posts.read') },
    async () => [{ id: 'p_1', title: 'Hello' }],
  )

  return { rbac, portal }
}
```

```ts [Express]
// src/rbac/wiring.ts
import { createRbac } from '@kyrobit/rbac'
import { rbacExpress } from '@kyrobit/rbac/express'
import { resources } from './policies.js'
import type { StorageAdapter } from '@kyrobit/rbac'
import type { Express } from 'express'

export function registerRbac(app: Express, adapter: StorageAdapter) {
  const rbac = createRbac({ adapter, resources })

  const { context, portal: createPortal, errorHandler } = rbacExpress(rbac)

  // Opens the per-request rbac context. Register BEFORE any portal guard.
  app.use(context())

  const portal = createPortal('admin', {
    // Resolved lazily at guard time, memoized per request per portal.
    // Return null when the request is unauthenticated → 401.
    getSubject: async req => {
      // Verification only — replace with your session/JWT lookup.
      const id = req.headers['x-user-id']
      return typeof id === 'string' && id !== '' ? { id } : null
    },
  })

  app.get('/posts', portal.requirePolicy('posts.read'), (_req, res) => {
    res.json([{ id: 'p_1', title: 'Hello' }])
  })

  // Register AFTER your routes: Express error middleware only handles errors
  // thrown by layers registered before it, so rbac errors would otherwise
  // fall through to the default HTML error page.
  app.use(errorHandler())

  return { rbac, portal }
}
```

:::

Boot the server:

::: code-group

```ts [Fastify]
// src/server.ts
import Fastify from 'fastify'
import { adapter } from './db/index.js'
import { registerRbac } from './rbac/wiring.js'

const app = Fastify()
await registerRbac(app, adapter)
await app.listen({ port: 3000 })
console.log('listening on http://localhost:3000')
```

```ts [Express]
// src/server.ts
import express from 'express'
import { adapter } from './db/index.js'
import { registerRbac } from './rbac/wiring.js'

const app = express()
registerRbac(app, adapter)
app.listen(3000, () => {
  console.log('listening on http://localhost:3000')
})
```

:::

## 7. Verify with curl

Start the server, then walk the three outcomes. Without a subject, the guard denies with 401 (Fastify's default error serializer and the Express `errorHandler()` shape the body differently, but both carry the same `code`):

::: code-group

```console [Fastify]
$ curl -s http://localhost:3000/posts
{"statusCode":401,"code":"RBAC_UNAUTHENTICATED","error":"Unauthorized","message":"Unauthorized"}
```

```console [Express]
$ curl -s http://localhost:3000/posts
{"message":"Unauthorized","code":"RBAC_UNAUTHENTICATED"}
```

:::

With a subject but no grant, the guard denies with 403:

::: code-group

```console [Fastify]
$ curl -s -H 'x-user-id: u_1' http://localhost:3000/posts
{"statusCode":403,"code":"RBAC_POLICY_DENIED","error":"Forbidden","message":"Forbidden"}
```

```console [Express]
$ curl -s -H 'x-user-id: u_1' http://localhost:3000/posts
{"message":"Forbidden","code":"RBAC_POLICY_DENIED"}
```

:::

Now assign the `editor` group to `u_1`. The portal on the request is `admin`, and grants are matched on (subject, portal, context) by strict equality, so the assignment must name the same portal — a grant with `portal: ''` would never apply to this request:

```ts
// scripts/grant.ts
import { createRbac } from '@kyrobit/rbac'
import { adapter } from '../src/db/index.js'

const rbac = createRbac({ adapter })
await rbac.admin.assignGroup({ subjectId: 'u_1', portal: 'admin' }, 'editor')
console.log('assigned group "editor" to u_1 on portal "admin"')
rbac.dispose()
process.exit(0)
```

```console
$ bun scripts/grant.ts
assigned group "editor" to u_1 on portal "admin"
```

(On Node without Bun, run it with `npx tsx scripts/grant.ts`.)

Request again:

```console
$ curl -s -H 'x-user-id: u_1' http://localhost:3000/posts
[{"id":"p_1","title":"Hello"}]
```

::: warning The grant can take up to 30 seconds to appear
The server caches each subject's policy map in a bounded in-memory cache with a 30 s TTL. Granting from a separate process (like `scripts/grant.ts`) cannot invalidate the server's cache — the default invalidation bus is in-process only — so if the server already answered a 403 for `u_1`, the stale entry lives until the TTL expires. Wait up to 30 s or restart the server. In production, assignments made through the running app invalidate immediately, and [`redisBus`](/guide/caching) propagates invalidations across instances.
:::

## Next steps

- [Defining policies](/guide/defining-policies) — resources, dependencies and scope options in depth.
- [Protecting routes](/guide/protecting-routes) — scoped guards, resource resolvers and stacking policies.
- [Drizzle + PostgreSQL](/databases/drizzle-postgres) (or [MySQL](/databases/drizzle-mysql), [SQLite](/databases/drizzle-sqlite), [Prisma](/databases/prisma), [Mongoose](/databases/mongoose)) — backend-specific details, ownership tracking and query scoping.
