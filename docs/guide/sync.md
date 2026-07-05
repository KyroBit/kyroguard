# Sync

Your definitions live in two files. `src/rbac/policies.ts` says what staff can do. `src/rbac/groups.ts` maps job titles to policies. One command loads both:

```sh
npx rbac sync
```

```
[rbac] Synced 5 policies.
[rbac] Seeded 2 groups.
[rbac] Wrote /home/you/app/rbac.d.ts
```

One run does five things:

1. Creates your policies and updates the ones that changed.
2. Deletes policies you removed from code.
3. Adds declared dependencies to every group that needs them ([how scopes carry over](/guide/groups#dependencies-are-filled-in)).
4. Seeds your groups from `groups.ts`.
5. Writes `rbac.d.ts` so policy names autocomplete.

Your code is the source of truth. The database follows it. Every domain in [`rbac.config.ts`](/reference/configuration) is synced in one run.

No files? `createRbac({ policies, groups })` plus `await rbac.sync()` runs the same pipeline.

## When to run it

Run it after every edit to `policies.ts` or `groups.ts`. Run it on every deploy, after migrations. Running it twice in a row changes nothing.

## Removing a policy

```
[rbac] Removed 1 orphaned policies: sales.refund
```

::: danger Deleting a policy deletes its grants
Remove a policy from code and the next sync removes it from the database. Every group entry and every user grant for it is deleted too. A rename counts as a delete plus a create. Grants do not carry over.
:::

A policies file that exports an empty array is skipped. Sync never wipes everything because a file exported nothing.

## Fresh database

Sync writes rows. It does not create tables. Run your migrations first, or sync stops with a hint:

```
$ npx rbac sync
[rbac] sync failed: relation "rbac_policies" does not exist
[rbac] The rbac tables do not exist yet — run your migrations first (drizzle-kit migrate, prisma migrate dev, or your migration tool).
```

## CI and deploys

```sh
npx drizzle-kit migrate   # or: npx prisma migrate deploy
npx rbac sync
node dist/server.js
```

Migrate, sync, start. Always in that order. Sync exits with code 1 on failure, so a broken deploy stops before the server starts.

## Types without a database

```sh
npx rbac generate
```

`generate` writes `rbac.d.ts` from your policy files only. It never opens a database connection. Use it in CI typechecks and on fresh checkouts.

## Next steps

- [CLI](/reference/cli) — all commands and flags
- [Configuration](/reference/configuration) — the `rbac.config.ts` schema
- [TypeScript](/guide/typescript) — how `rbac.d.ts` types your guards
