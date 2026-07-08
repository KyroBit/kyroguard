# CLI

The `kyroguard` binary ships with `@kyrobit/kyroguard`.

```sh
kyroguard <command> [options]
```

| Command | What it does |
| --- | --- |
| [`init`](#kyroguard-init) | Scaffold config, starter policies, groups and domains |
| [`sync`](#kyroguard-sync) | Push policies and groups to the database, then write `kyroguard.d.ts` |
| [`generate`](#kyroguard-generate) | Write `kyroguard.d.ts` only, no database needed |
| [`status`](#kyroguard-status) | Show adapter id, capabilities and stored counts |

Every command except `init` loads your [`kyroguard.config.ts`](/reference/configuration). TypeScript configs work without a build step, on Node and Bun. The CLI loads `.env` from the working directory first, so `DATABASE_URL` is available inside your config.


## kyroguard init

```sh
kyroguard init [--yes]
```

Scaffolds a working setup into the current directory. It detects your framework, ORM and dialect from `package.json`, then asks you to confirm each choice. It never opens a database connection and never overwrites an existing file without asking.

| Flag | Description |
| --- | --- |
| `--yes` | Accept the detected stack and skip all prompts. Existing files are kept. |

```
$ kyroguard init --yes
[kyroguard] Detected stack:
  framework: fastify
  orm:       drizzle
  dialect:   pg

  wrote   kyroguard.config.ts
  wrote   src/kyroguard/policies.ts
  wrote   src/kyroguard/groups.ts
  wrote   src/kyroguard/domains.ts
  wrote   src/db/kyroguard-schema.ts

[kyroguard] Next steps:
  1. Add src/db/kyroguard-schema.ts to your drizzle config schema paths.
  2. Run your migrations (drizzle-kit generate && drizzle-kit migrate, or push).
  3. Finish the TODOs in kyroguard.config.ts and src/kyroguard/domains.ts.
  4. Run `kyroguard sync`.
```

With Prisma it writes `prisma/kyroguard.prisma` instead of the Drizzle schema file. With Mongoose there is no schema file at all. See the setup pages: [Drizzle](/databases/drizzle), [Prisma](/databases/prisma), [MongoDB](/databases/mongodb).

## kyroguard sync

```sh
kyroguard sync [--config <path>]
```

Pushes your policy and group files to the database, then writes `kyroguard.d.ts`. New policies are inserted, changed ones are updated, and removed ones are deleted together with their grants. Groups are reseeded to match your group files exactly.

| Flag | Description |
| --- | --- |
| `--config <path>` | Config file to load. Default: search the working directory. |

```
$ kyroguard sync
[kyroguard] Removed 1 orphaned policies: teachers.grades.export
[kyroguard] Synced 4 policies.
[kyroguard] Seeded 2 groups for domain "teachers".
[kyroguard] Wrote /home/you/app/kyroguard.d.ts
```

::: warning Run migrations first
`sync` writes rows. It does not create tables. On a fresh database it fails with a hint:

```
$ kyroguard sync
[kyroguard] sync failed: relation "kyroguard_policies" does not exist
[kyroguard] The kyroguard tables do not exist yet — run your migrations first (drizzle-kit migrate, prisma migrate dev, or your migration tool).
```
:::

A policies module that exports an empty list is skipped. `sync` never wipes a domain because a file exported nothing. See [Syncing policies](/guide/sync) for what changes in the database, step by step.

## kyroguard generate

```sh
kyroguard generate [--config <path>]
```

Writes `kyroguard.d.ts` from your policy files. It never opens a database connection, so it is safe in CI and pre-commit hooks. The generated file gives `requirePolicy` and the assignment methods policy-name autocompletion.

| Flag | Description |
| --- | --- |
| `--config <path>` | Config file to load. Default: search the working directory. |

```
$ kyroguard generate
[kyroguard] Wrote /home/you/app/kyroguard.d.ts
```

Use `sync` when policies changed and the database must follow. Use `generate` when you only need the types. See [TypeScript](/guide/typescript).

## kyroguard status

```sh
kyroguard status [--config <path>]
```

Connects through your config's adapter and prints diagnostics. Use it to confirm the CLI reaches the same database as your app.

| Flag | Description |
| --- | --- |
| `--config <path>` | Config file to load. Default: search the working directory. |

```
$ kyroguard status
adapter:      drizzle-pg
capabilities: autoOwnershipTracking=true listFiltering=true
policies:     4
groups:       2
```

Adapter ids: `drizzle-pg`, `drizzle-mysql`, `drizzle-sqlite`, `prisma`, `mongoose`, or `memory` in tests. Counts are totals across all domains.

## Global flags

| Flag | Description |
| --- | --- |
| `--config <path>` | Path to `kyroguard.config.{ts,mts,mjs,js}`. Default: search the working directory. |
| `--yes` | Skip prompts (`init` only). |
| `--help` | Print usage and exit 0. |
| `--version` | Print the CLI version and exit 0. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Command completed. |
| `1` | Unknown command or flag, no command given, config missing or invalid, or any command failure. |

Failures print one `[kyroguard] ...` line to stderr. `sync` and `status` close the database connection before exiting, even on failure — the CLI always terminates, even when your config opens connections of its own.
