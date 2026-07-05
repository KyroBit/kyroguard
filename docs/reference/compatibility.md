# Compatibility

Supported runtimes, framework and ORM version ranges, module format constraints and the versioning policy for `@kyrobit/rbac` v1.

## Support matrix

| Dependency | Supported range | Notes |
| --- | --- | --- |
| Node.js | `>=20.19` | Enforced by the package `engines` field. |
| Bun | `>=1.1` | The CLI detects Bun and imports TypeScript config files natively (no jiti). |
| TypeScript | `>=5.0` | With `moduleResolution` set to `bundler`, `node16` or `nodenext` — see below. |
| fastify | `^5.0.0` | The plugin declares `fastify: '5.x'`; registration on Fastify 4 fails. |
| express | `^4.18.0 \|\| ^5.0.0` | Guards forward async rejections explicitly, so behavior is identical on 4 and 5. |
| drizzle-orm | `>=0.36.0 <2` | PostgreSQL, MySQL and SQLite via `@kyrobit/rbac/drizzle/schema/{pg,mysql,sqlite}`. |
| @prisma/client | `^5.0.0 \|\| ^6.0.0` | Structural adapter — the package never imports `@prisma/client`; any client generated from the six rbac models works. |
| mongoose | `^8.0.0` | Connection-scoped models; multiple connections per process are supported. |

All framework and ORM packages are **optional peer dependencies**: install only what you use. The core entry (`@kyrobit/rbac`) imports none of them, and each integration lives at its own subpath (`/fastify`, `/express`, `/drizzle`, `/drizzle/schema/pg`, `/drizzle/schema/mysql`, `/drizzle/schema/sqlite`, `/prisma`, `/mongoose`, `/cache`, `/testing`), so importing the Fastify integration never loads Express or an ORM.

## ESM only

The package ships ES modules only (`"type": "module"`, no CJS build, no `require` conditions in the exports map).

- `import` works everywhere in the supported range.
- `require('@kyrobit/rbac')` from CommonJS code **also works on every supported Node version**: Node supports `require()` of ES modules (`require(esm)`) from 20.19 onward, which is exactly why the floor is 20.19 rather than 20.0.
- Bun loads either format.

## TypeScript configuration

Subpath types (`@kyrobit/rbac/fastify`, `/drizzle`, ...) are declared through the package `exports` map. TypeScript only reads `exports` under these settings:

```jsonc
// tsconfig.json — one of:
{ "compilerOptions": { "moduleResolution": "bundler" } }   // bundled apps
{ "compilerOptions": { "moduleResolution": "nodenext" } }  // node ESM projects
{ "compilerOptions": { "moduleResolution": "node16" } }    // node ESM projects
```

::: warning `moduleResolution: "node"` cannot resolve subpath types
The legacy `node` (node10) resolver ignores the `exports` map: `import { rbacFastify } from '@kyrobit/rbac/fastify'` then fails with TS2307 ("Cannot find module") even though the runtime import would work. Switch to `bundler`, `node16` or `nodenext`.
:::

The generated `rbac.d.ts` uses `declare module '@kyrobit/rbac'` augmentation and works under all three supported resolution modes. Make sure it is inside your `include` globs.

## Storage backends

| Backend | Adapter | Auto ownership tracking | Query scoping |
| --- | --- | --- | --- |
| PostgreSQL (Drizzle) | `drizzleAdapter(db, { schema })` with the `pg` schema | yes (`trackedDb`) | yes |
| MySQL (Drizzle) | same, `mysql` schema | yes | yes |
| SQLite / Turso (Drizzle) | same, `sqlite` schema | yes | yes |
| PostgreSQL / MySQL / SQLite (Prisma) | `prismaAdapter(client)` | yes (`rbacPrismaExtension`) | no — use [guard-time scopes](/guide/writing-scopes) |
| MongoDB (Mongoose) | `mongooseAdapter(connection)` | yes (`rbacMongoosePlugin`) | yes |
| In-memory (testing) | `memoryAdapter()` from `@kyrobit/rbac/testing` | no | no |

Every adapter passes the same contract suite (`runStorageAdapterContractSuite` from `@kyrobit/rbac/testing`), so guard behavior does not vary by backend. Custom adapters can run the suite to prove conformance — see [Writing a storage adapter](/guide/writing-a-storage-adapter).

## Versioning policy

`@kyrobit/rbac` follows semver with one addition specific to this package: the storage adapter contract clauses (S1–S20 in `src/storage/contract.ts`) are normative API.

- **Major** — any change to the meaning of an existing S-clause (matching rules, sentinel semantics, idempotency guarantees, cascade behavior), a changed `RBAC_*` code or HTTP status, a changed default response body shape, or a dropped runtime/peer range. If a conforming v1 adapter or a client branching on `code` could break, it is a major.
- **Minor** — new commands, options, exports or S-clauses that existing conforming adapters already satisfy.
- **Patch** — fixes that bring behavior in line with the documented contract.

The `RBAC_*` error codes and the `rbac:v1:` cache key prefix are stable for the life of v1.

## Next steps

- [Installation](/guide/installation) — package setup per stack.
- [Errors](/reference/errors) — the stable `RBAC_*` contract clients can rely on.
- [Testing your app](/guide/testing-your-app) — the in-memory adapter and contract suites.
