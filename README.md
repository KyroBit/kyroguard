# KyroGuard

Policy-based access control for Node.js and Bun services. Define permissions
in code, group them into roles, assign them to users per domain and per
tenant, and enforce them on routes. One command keeps the database and your
TypeScript types in sync.

- **Framework-agnostic core** with first-class integrations for Fastify 5 and
  Express 4/5.
- **Storage adapters** for Drizzle (PostgreSQL, MySQL, SQLite), Prisma and
  Mongoose — all certified against the same behavioral contract test suite.
- **Strict isolation**: domain and tenant assignments match by exact
  equality. A grant in one domain or tenant never applies in another.
- **Typed decisions**: guards throw typed errors (`UNAUTHENTICATED`,
  `ACCESS_DENIED`, …) through your framework's own error pipeline.
- **Bounded cache** (LRU + TTL, instance-scoped) with a pluggable
  cross-instance invalidation bus.
- **Scoped grants** — a condition on a permission, written against your own
  tables: own rows only, this tenant only, business hours. kyroguard ANDs it
  into every query for that resource — reads, updates and deletes alike.

## Install

```bash
npm install @kyrobit/kyroguard
npx kyroguard init   # detects your stack, scaffolds schema + config + policies + domains
```

## At a glance

```ts
// guard.ts
import { createGuard } from '@kyrobit/kyroguard'
import { drizzleAdapter } from '@kyrobit/kyroguard/drizzle'
import * as schema from './db/kyroguard-schema'
import { db } from './db'

export const guard = createGuard({ adapter: drizzleAdapter(db, { schema }) })
```

```ts
// Fastify
await app.register(kyroguardFastify(guard))
const admin = app.kyroguard.domain('admin', { getSubject: req => auth.user(req) })

app.get('/transactions/:id', {
  preHandler: admin.requirePolicy('transactions.view'),
}, handler)
```

A subject without `admin.transactions.view` receives:

```json
{ "statusCode": 403, "code": "ACCESS_DENIED", "error": "Forbidden", "message": "Forbidden" }
```

## Documentation

Full documentation lives in [`docs/`](./docs) (VitePress — `bun run docs:dev`):
installation per stack, guides for domains, tenants, scopes, ownership,
caching and observability, a complete API and CLI reference, the database
schema and an error encyclopedia.

## Requirements

| | |
|---|---|
| Runtime | Node ≥ 20.19 or Bun ≥ 1.1 (ESM-only) |
| Frameworks | Fastify ^5 · Express ^4.18 \|\| ^5 |
| Storage | Drizzle ≥ 0.36 (pg/mysql/sqlite) · Prisma ^5 \|\| ^6 · Mongoose ^8 |

kyroguard installs none of them. Add the framework and ORM you use; only what you
import is loaded.

## Development

```bash
bun install
bun run typecheck
bun test tests/
```

Storage adapters must pass `runStorageAdapterContractSuite`; framework
integrations must pass `runFrameworkContractSuite` (both exported from
`@kyrobit/kyroguard/testing`). See [CONTRIBUTING.md](./CONTRIBUTING.md) and
[SECURITY.md](./SECURITY.md).
