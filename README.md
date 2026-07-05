# @kyrobit/rbac

Policy-based access control for Node.js and Bun services. Define permissions
in code, group them into roles, assign them to users per portal and per
tenant, and enforce them on routes. One command keeps the database and your
TypeScript types in sync.

- **Framework-agnostic core** with first-class integrations for Fastify 5 and
  Express 4/5.
- **Storage adapters** for Drizzle (PostgreSQL, MySQL, SQLite), Prisma and
  Mongoose — all certified against the same behavioral contract test suite.
- **Strict isolation**: portal and tenant-context assignments match by exact
  equality. A grant in one portal or tenant never applies in another.
- **Typed decisions**: guards throw typed errors (`RBAC_POLICY_DENIED`,
  `RBAC_SCOPE_DENIED`, …) through your framework's own error pipeline.
- **Bounded cache** (LRU + TTL, instance-scoped) with a pluggable
  cross-instance invalidation bus.
- **Ownership tracking** and row-level scopes (`Scope.owned()`) that work on
  every storage backend.

## Install

```bash
npm install @kyrobit/rbac
npx rbac init   # detects your stack, scaffolds schema + config + wiring
```

## At a glance

```ts
// rbac.ts
import { createRbac } from '@kyrobit/rbac'
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from './db/rbac-schema'
import { db } from './db'

export const rbac = createRbac({ adapter: drizzleAdapter(db, { schema }) })
```

```ts
// Fastify
await app.register(rbacFastify(rbac))
const admin = app.rbac.portal('admin', { getSubject: req => auth.user(req) })

app.get('/transactions/:id', {
  preHandler: admin.requirePolicy('transactions.view', {
    resource: req => ({ type: 'transaction', id: req.params.id }),
  }),
}, handler)
```

A subject without `admin.transactions.view` receives:

```json
{ "statusCode": 403, "code": "RBAC_POLICY_DENIED", "error": "Forbidden", "message": "Forbidden" }
```

## Documentation

Full documentation lives in [`docs/`](./docs) (VitePress — `bun run docs:dev`):
installation per stack, guides for portals, tenant contexts, scopes,
ownership, caching and observability, a complete API and CLI reference, the
database schema, an error encyclopedia and the v0 → v1 migration guide.

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
`@kyrobit/rbac/testing`). See [CONTRIBUTING.md](./CONTRIBUTING.md) and
[SECURITY.md](./SECURITY.md).
