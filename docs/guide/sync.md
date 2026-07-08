# Sync

Your definitions live in two files. `src/kyroguard/policies.ts` says what users can do. `src/kyroguard/groups.ts` maps job titles to policies. One command loads both:

```sh
npx kyroguard sync
```

```
[kyroguard] Synced 4 policies.
[kyroguard] Seeded 2 groups.
[kyroguard] Wrote /home/you/app/kyroguard.d.ts
```

One run does five things:

1. Creates your policies and updates the ones that changed.
2. Deletes policies you removed from code.
3. Adds declared dependencies to every group that needs them ([how scopes carry over](/guide/groups#dependencies-are-filled-in)).
4. Seeds your groups from `groups.ts`.
5. Writes `kyroguard.d.ts` so policy names autocomplete.

Your code is the source of truth. The database follows it. Every domain in [`kyroguard.config.ts`](/reference/configuration) is synced in one run.

No files? `createKyroguard({ policies, groups })` plus `await guard.sync()` runs the same pipeline.

## When to run it

Run it after every edit to `policies.ts` or `groups.ts`. Run it on every deploy, after migrations. Running it twice in a row changes nothing.

## Removing a policy

```
[kyroguard] Removed 1 orphaned policies: grades.finalize
```

::: danger Deleting a policy deletes its grants
Remove a policy from code and the next sync removes it from the database. Every group entry and every user grant for it is deleted too. A rename counts as a delete plus a create. Grants do not carry over.
:::

A policies file that exports an empty array is skipped. Sync never wipes everything because a file exported nothing.

## Fresh database

Sync writes rows. It does not create tables. Run your migrations first, or sync stops with a hint:

```
$ npx kyroguard sync
[kyroguard] sync failed: relation "kyroguard_policies" does not exist
[kyroguard] The kyroguard tables do not exist yet — run your migrations first (drizzle-kit migrate, prisma migrate dev, or your migration tool).
```

## CI and deploys

```sh
npx drizzle-kit migrate   # or: npx prisma migrate deploy
npx kyroguard sync
node dist/server.js
```

Migrate, sync, start. Always in that order. Sync exits with code 1 on failure, so a broken deploy stops before the server starts.

## Running sync from scripts

Seed scripts and package runners sometimes need more than the bare command. The package is scoped (`@kyrobit/kyroguard`) while the binary is named `kyroguard` — when a runner cannot find the bare name in a local `node_modules/.bin`, it falls back to asking the **public npm registry for a package named `kyroguard`**, which does not exist, and fails with a 404. Whether the bare name resolves locally depends on the tool and your workspace layout, so scripts should use one of the forms that always works.

A package.json script is the most portable — the script's PATH always includes every `.bin` up the tree:

```jsonc
{ "scripts": { "kyroguard:sync": "kyroguard sync" } }
```

```sh
bun run kyroguard:sync    # or: npm run kyroguard:sync
```

Calling a runner directly, pass the package name, not the bin name:

```sh
npx @kyrobit/kyroguard sync
bunx --bun @kyrobit/kyroguard sync
```

Shelling out from code (a seed script), the explicit bin path is immune to every resolution quirk:

```ts
execSync('bun node_modules/.bin/kyroguard sync', { stdio: 'inherit' })
```

## Types without a database

```sh
npx kyroguard generate
```

`generate` writes `kyroguard.d.ts` from your policy files only. It never opens a database connection. Use it in CI typechecks and on fresh checkouts.

## Next steps

- [CLI](/reference/cli) — all commands and flags
- [Configuration](/reference/configuration) — the `kyroguard.config.ts` schema
- [TypeScript](/guide/typescript) — how `kyroguard.d.ts` types your guards
