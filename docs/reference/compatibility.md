# Compatibility

Supported runtimes and version ranges for `@kyrobit/rbac` v1.

| Dependency | Supported range | Notes |
| --- | --- | --- |
| Node.js | `>=20.19` | Enforced by the package `engines` field. |
| Bun | `>=1.1` | The CLI runs TypeScript configs natively under Bun. |
| TypeScript | `>=5.0` | With `moduleResolution` set to `bundler`, `node16` or `nodenext`. |
| fastify | `^5.0.0` | Registration on Fastify 4 fails. |
| express | `^4.18.0 \|\| ^5.0.0` | Identical behavior on 4 and 5. |
| drizzle-orm | `>=0.36.0 <2` | PostgreSQL, MySQL and SQLite. |
| @prisma/client | `^5.0.0 \|\| ^6.0.0` | Any client generated from the six rbac models. |
| mongoose | `^8.0.0` | Multiple connections per process are supported. |

All framework and ORM packages are optional peer dependencies. Install only what you use. Each integration lives at its own subpath, so importing `@kyrobit/rbac/fastify` never loads Express or an ORM.

## ESM only

The package ships ES modules only. `import` works everywhere in the supported range. `require('@kyrobit/rbac')` from CommonJS also works, because Node supports `require()` of ES modules from 20.19 onward. That is why the floor is 20.19.

## moduleResolution

Subpath imports like `@kyrobit/rbac/fastify` need a resolver that reads the package `exports` map:

```jsonc
// tsconfig.json — one of:
{ "compilerOptions": { "moduleResolution": "bundler" } }   // bundled apps
{ "compilerOptions": { "moduleResolution": "nodenext" } }  // node ESM projects
```

The legacy `"node"` setting fails with TS2307 on every subpath import. Also keep the generated `rbac.d.ts` inside your `include` globs.

## Semver

The package follows semver. A major release is anything that could break a client branching on an error `code`, an HTTP status, or a custom storage adapter. The `RBAC_*` error codes are stable for the life of v1. See [Errors](/reference/errors) and [Custom adapters](/guide/custom-adapters).

## Runtimes

Node 20.19+ and Bun 1.1+ are tested. Every storage adapter passes the same contract test suite, so guard behavior does not vary by backend or runtime. See [Testing](/guide/testing).
