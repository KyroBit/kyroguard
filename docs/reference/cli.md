# CLI

The `rbac` binary ships with `@kyrobit/rbac`. It scaffolds a project (`init`), pushes your policies-as-code to storage (`sync`), writes typed policy declarations (`generate`) and inspects your storage backend (`status`).

```
rbac — policies-as-code sync, typegen and scaffolding for @kyrobit/rbac

Usage
  rbac <command> [options]

Commands
  init      Scaffold rbac.config.ts, starter policies/groups and wiring
  sync      Push policies + groups to storage, then write rbac.d.ts
  generate  Write rbac.d.ts from your policy files only (no database)
  status    Show adapter id, capabilities and stored policy/group counts

Options
  --config <path>  Path to rbac.config.{ts,mts,mjs,js} (default: search cwd)
  --yes            Accept defaults and skip prompts (init)
  --help           Show this help
  --version        Print the CLI version
```

## How the CLI runs your config

Every command except `init` starts by loading your [`rbac.config.ts`](/reference/configuration):

- **Under Node**, the config and your policy/group modules are imported through [jiti](https://github.com/unjs/jiti), so TypeScript config files work without a build step.
- **Under Bun**, they are imported natively — Bun executes TypeScript directly and jiti is never loaded.

The CLI itself never imports a database driver or ORM. Your config's lazy `adapter` factory owns those imports, and only `sync` and `status` ever call it. `generate` writes types without opening a database connection.

Before parsing arguments, the CLI loads `.env` from the current working directory (via `process.loadEnvFile`, silently skipped when the file does not exist), so `DATABASE_URL`-style variables are available inside your adapter factory.

Relative paths behave as follows: `--config` resolves against the current working directory; the `policies`, `groups` and `typegen.output` paths inside the config resolve against the **config file's directory**, so `rbac sync` produces the same result from any working directory.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Command completed. `--help` and `--version` also exit 0. |
| `1` | Unknown flag or command, `rbac` run with no command, config not found or invalid, or any command failure (`sync`/`status` errors, unreadable policy modules). |

Failures print a single `[rbac] ...` line to stderr; `sync` and `status` always close the adapter connection before exiting, even on failure.

## `rbac init`

Scaffolds a working setup into the current directory. Reads `package.json` (dependencies and devDependencies) and any `drizzle.config.{ts,mts,js,mjs,cjs}` to detect your stack:

- **framework** — `fastify` if present, else `express`, else not detected
- **orm** — `drizzle-orm` if present, else Prisma (`@prisma/client` or `prisma`), else `mongoose`, else not detected
- **dialect** — for Drizzle, from the `dialect:` field of your drizzle config (`postgresql` → pg, `mysql` → mysql, `sqlite`/`turso` → sqlite), falling back to installed driver packages (`pg`/`postgres`, `mysql2`, `better-sqlite3`/`libsql`/`@libsql/client`); for Prisma, from the `provider` of the `datasource` block in `prisma/schema.prisma` (or a root `schema.prisma`)

It then prompts for framework, ORM, dialect (Drizzle only — the Prisma models are provider-agnostic and Mongoose has no dialect) and a portal name (default `admin`). With `--yes` it skips all prompts and uses the detected values, falling back to `fastify` / `drizzle` / `pg` / `admin`.

**Writes:**

| File | Content |
| --- | --- |
| `rbac.config.ts` | CLI config with a lazy adapter factory for your ORM |
| `src/rbac/policies.ts` | Starter `ResourceDefinition[]` (a `post` resource) |
| `src/rbac/groups.ts` | Starter `GroupsDefinition` (`admin`, `editor`) |
| `src/rbac/wiring.ts` | `createRbac` + framework integration for Fastify or Express |
| `src/db/rbac-schema.ts` | The six rbac tables for your dialect (Drizzle only) |
| `prisma/rbac.prisma` | The six rbac tables as Prisma models (Prisma only; written as `rbac.prisma` next to a root-level `schema.prisma` when there is no `prisma/` directory) |

Existing files are never overwritten silently: interactively you are asked per file (default: keep), and with `--yes` existing files are always skipped and reported as `skipped`. `init` never opens a database connection.

```
$ rbac init --yes
[rbac] Detected stack:
  framework: fastify
  orm:       drizzle
  dialect:   pg

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

## `rbac sync`

Pushes your policies and groups to storage, then regenerates types. In order:

1. Calls your `adapter()` factory once (this is where the database connection opens) and the adapter's `ensureSchema()` if it has one — Drizzle and Prisma have none (migrations own DDL), `syncIndexes()` for Mongoose.
2. For each portal in the config, loads the portal's `policies` module and validates every `dependsOn` reference against the defined policy names.
3. Upserts the portal's policies (updating `label`, `scopeOptions`, `dependsOn` on existing rows), deletes orphaned policies **for this portal only** — orphan detection filters on the stored `portal` column, never on name shape — and back-fills missing transitive dependencies into every stored group.
4. If the portal has a `groups` path, seeds those groups (replace-all per group: the stored entries become exactly what the module declares).
5. After all portals: writes the `rbac.d.ts` declaration file to `typegen.output` (default `./rbac.d.ts` next to the config).

**Reads:** config, policy modules, group modules. **Writes:** rows in all six rbac tables, plus `rbac.d.ts`.

```
$ rbac sync
[rbac] Removed 1 orphaned policies: admin.posts.archive
[rbac] Synced 4 policies.
[rbac] Seeded 2 groups for portal "admin".
[rbac] Wrote /home/you/app/rbac.d.ts
```

::: warning Run migrations before the first sync
`sync` writes rows; it does not create SQL tables. On a fresh database it fails with the backend's missing-table error and a hint:

```
$ rbac sync
[rbac] sync failed: relation "rbac_policies" does not exist
[rbac] The rbac tables do not exist yet — run your migrations first (drizzle-kit push / migrate).
```

Adapters are required to reject (never silently no-op) when tables are missing, so a misconfigured database cannot look like a successful sync.
:::

An empty policy list returns early on purpose — `sync` never wipes a portal because a module accidentally exported nothing.

## `rbac generate`

Writes `rbac.d.ts` from your policy files only. It never calls the adapter factory and never opens a database connection, so it is safe in CI steps and pre-commit hooks that have no database access.

The generated file augments the `RbacTypes` interface of `@kyrobit/rbac`, which gives `requirePolicy` and the assignment methods per-portal policy-name autocompletion. Every portal and policy name is JSON-escaped during generation, so names cannot inject declaration code.

```
$ rbac generate
[rbac] Wrote /home/you/app/rbac.d.ts
```

Use `sync` when policies changed and storage must follow; use `generate` when you only need the types (fresh checkout, CI typecheck).

## `rbac status`

Connects via your adapter factory and prints diagnostics: the adapter id, its capability flags and the stored policy and group counts (totals across all portals).

```
$ rbac status
adapter:      drizzle-pg
capabilities: autoOwnershipTracking=true queryScoping=true
policies:     4
groups:       2
```

Adapter ids are `drizzle-pg`, `drizzle-mysql`, `drizzle-sqlite`, `prisma`, `mongoose`, or `memory` for the testing adapter. `autoOwnershipTracking` and `queryScoping` report whether `trackedDb` (Drizzle), `rbacPrismaExtension` (Prisma, tracking only) or the Mongoose plugin features are available for this backend.

## `--version` and `--help`

```
$ rbac --version
1.0.0
```

`rbac --help` prints the usage block and exits 0. Running `rbac` with no command prints the same usage but exits 1, so a broken script invocation fails loudly.

## Next steps

- [Configuration](/reference/configuration) — the full `rbac.config.ts` schema and why the adapter factory is lazy.
- [Syncing policies](/guide/syncing-policies) — what sync changes in storage, step by step.
- [TypeScript](/guide/typescript) — how the generated `rbac.d.ts` types flow into guards.
