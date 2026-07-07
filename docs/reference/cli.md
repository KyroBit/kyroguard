# CLI

The `rbac` binary ships with `@kyrobit/rbac`.

```sh
rbac <command> [options]
```

| Command | What it does |
| --- | --- |
| [`init`](#rbac-init) | Scaffold config, starter policies, groups and wiring |
| [`sync`](#rbac-sync) | Push policies and groups to the database, then write `rbac.d.ts` |
| [`generate`](#rbac-generate) | Write `rbac.d.ts` only, no database needed |
| [`status`](#rbac-status) | Show adapter id, capabilities and stored counts |

Every command except `init` loads your [`rbac.config.ts`](/reference/configuration). TypeScript configs work without a build step, on Node and Bun. The CLI loads `.env` from the working directory first, so `DATABASE_URL` is available inside your config.

## rbac init

```sh
rbac init [--yes]
```

Scaffolds a working setup into the current directory. It detects your framework, ORM and dialect from `package.json`, then asks you to confirm each choice. It never opens a database connection and never overwrites an existing file without asking.

| Flag | Description |
| --- | --- |
| `--yes` | Accept the detected stack and skip all prompts. Existing files are kept. |

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

With Prisma it writes `prisma/rbac.prisma` instead of the Drizzle schema file. With Mongoose there is no schema file at all. See the setup pages: [Drizzle](/databases/drizzle), [Prisma](/databases/prisma), [MongoDB](/databases/mongodb).

## rbac sync

```sh
rbac sync [--config <path>]
```

Pushes your policy and group files to the database, then writes `rbac.d.ts`. New policies are inserted, changed ones are updated, and removed ones are deleted together with their grants. Groups are reseeded to match your group files exactly.

| Flag | Description |
| --- | --- |
| `--config <path>` | Config file to load. Default: search the working directory. |

```
$ rbac sync
[rbac] Removed 1 orphaned policies: teachers.grades.export
[rbac] Synced 4 policies.
[rbac] Seeded 2 groups for domain "teachers".
[rbac] Wrote /home/you/app/rbac.d.ts
```

::: warning Run migrations first
`sync` writes rows. It does not create tables. On a fresh database it fails with a hint:

```
$ rbac sync
[rbac] sync failed: relation "rbac_policies" does not exist
[rbac] The rbac tables do not exist yet — run your migrations first (drizzle-kit migrate, prisma migrate dev, or your migration tool).
```
:::

A policies module that exports an empty list is skipped. `sync` never wipes a domain because a file exported nothing. See [Syncing policies](/guide/sync) for what changes in the database, step by step.

## rbac generate

```sh
rbac generate [--config <path>]
```

Writes `rbac.d.ts` from your policy files. It never opens a database connection, so it is safe in CI and pre-commit hooks. The generated file gives `requirePolicy` and the assignment methods policy-name autocompletion.

| Flag | Description |
| --- | --- |
| `--config <path>` | Config file to load. Default: search the working directory. |

```
$ rbac generate
[rbac] Wrote /home/you/app/rbac.d.ts
```

Use `sync` when policies changed and the database must follow. Use `generate` when you only need the types. See [TypeScript](/guide/typescript).

## rbac status

```sh
rbac status [--config <path>]
```

Connects through your config's adapter and prints diagnostics. Use it to confirm the CLI reaches the same database as your app.

| Flag | Description |
| --- | --- |
| `--config <path>` | Config file to load. Default: search the working directory. |

```
$ rbac status
adapter:      drizzle-pg
capabilities: autoOwnershipTracking=true queryScoping=true
policies:     4
groups:       2
```

Adapter ids: `drizzle-pg`, `drizzle-mysql`, `drizzle-sqlite`, `prisma`, `mongoose`, or `memory` in tests. Counts are totals across all domains.

## Global flags

| Flag | Description |
| --- | --- |
| `--config <path>` | Path to `rbac.config.{ts,mts,mjs,js}`. Default: search the working directory. |
| `--yes` | Skip prompts (`init` only). |
| `--help` | Print usage and exit 0. |
| `--version` | Print the CLI version and exit 0. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Command completed. |
| `1` | Unknown command or flag, no command given, config missing or invalid, or any command failure. |

Failures print one `[rbac] ...` line to stderr. `sync` and `status` close the database connection before exiting, even on failure.
