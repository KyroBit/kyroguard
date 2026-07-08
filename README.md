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
- **Scoped grants** — conditions on a permission: own rows only
  (`Scope.owned()`, backed by ownership tracking on every storage
  backend), business hours, amount caps — one line in a role definition.

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
  preHandler: admin.requirePolicy('transactions.view', {
    resource: req => ({ type: 'transaction', id: req.params.id }),
  }),
}, handler)
```

A subject without `admin.transactions.view` receives:

```json
{ "statusCode": 403, "code": "ACCESS_DENIED", "error": "Forbidden", "message": "Forbidden" }
```

## Documentation

Full documentation lives in [`docs/`](./docs) (VitePress — `bun run docs:dev`):
installation per stack, guides for domains, tenants, scopes,
ownership, caching and observability, a complete API and CLI reference, the
database schema and an error encyclopedia.

## Requirements

| | |
|---|---|
| Runtime | Node ≥ 20.19 or Bun ≥ 1.1 (ESM-only) |
| Frameworks | Fastify ^5 · Express ^4.18 \|\| ^5 |
| Storage | Drizzle ≥ 0.36 (pg/mysql/sqlite) · Prisma ^5 \|\| ^6 · Mongoose ^8 |

All framework and ORM packages are optional peer dependencies — only what you
import is required.

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
