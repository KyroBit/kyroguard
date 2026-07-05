# Organizing groups

A group bundles policies into a role you assign to users — `admin`, `editor`, `moderator`. On this page you write a `groups.ts` seed file, pick a seed format per group, and control groups at runtime with the `isSystem` and `isActive` flags.

::: tip Prerequisites
Groups reference policies by name, so define your policies first — see [Defining policies](/guide/defining-policies).
:::

## Seeding groups

### 1. Create `src/rbac/groups.ts`

The file exports a `GroupsDefinition` named `groups` (a default export also works). Policy names are unqualified — `seedGroups` adds the portal prefix, exactly like policy sync does:

```ts
// src/rbac/groups.ts
import type { GroupsDefinition } from '@kyrobit/rbac'

export const groups: GroupsDefinition = {
  admin: {
    label: 'Administrator',
    description: 'Every policy in this portal, unrestricted',
    isSystem: true,
    policies: 'all',
  },
  editor: {
    label: 'Editor',
    description: 'Writes posts, edits and deletes only their own',
    policies: {
      'posts.view': null,
      'posts.create': null,
      'posts.update': 'owned',
      'posts.delete': 'owned',
    },
  },
  moderator: {
    label: 'Moderator',
    policies: ['comments.view', 'comments.moderate'],
  },
}
```

### 2. Register the file in `rbac.config.ts`

```ts
portals: [
  {
    name: 'admin',
    policies: './src/rbac/policies.ts',
    groups: './src/rbac/groups.ts', // [!code ++]
  },
],
```

### 3. Sync

```sh
npx rbac sync
```

Policies sync first, then each group is upserted and its policy entries are written:

```
[rbac] Synced 7 policies.
[rbac] Seeded 3 groups for portal "admin".
```

## Choosing a seed format

`policies` accepts three shapes (`GroupPoliciesInput`):

| Format | Example | Result |
| --- | --- | --- |
| `'all'` | `policies: 'all'` | Every policy synced for this portal, unrestricted. |
| `string[]` | `['comments.view', 'comments.moderate']` | The listed policies, unrestricted. |
| `Record<string, string \| null>` | `{ 'posts.update': 'owned' }` | Policy → scope name; `null` means unrestricted. |

`'all'` is resolved against the portal's own policy list, which the CLI passes to `seedGroups` automatically — so an `admin` group in the `admin` portal never absorbs another portal's policies. If you call `seedGroups` yourself, `'all'` requires the policy list as the third argument, otherwise it throws:

```
[rbac] seedGroups: group "admin" uses policies: 'all' but no allPolicies array was passed as the third argument.
```

### Scoped entries

The record format attaches a scope name to a grant: `'posts.update': 'owned'` lets editors update only rows they own. The scope name must match a `Scope` you registered through some policy's `scopeOptions` — grants store the name, and the engine resolves it at request time.

::: warning A misspelled scope name denies, it does not fail the sync
Seeding does not validate scope names. `'posts.update': 'onwed'` seeds without an error, and every editor's update request is then denied with 403 — an unresolvable scope fails closed, because treating it as "no restriction" would widen access:

```json
{
  "message": "Forbidden",
  "code": "RBAC_SCOPE_DENIED"
}
```

If editors suddenly get 403 with `RBAC_SCOPE_DENIED` on rows they own, check the scope names in `groups.ts` against your `scopeOptions`.
:::

## Using `isSystem` and `isActive`

Every group carries two flags. On first insert they default to `isSystem: false`, `isActive: true`. On a later upsert, an **omitted** flag keeps its stored value — passing nothing never resets a flag, which is what lets re-seeding coexist with runtime changes (see below).

**`isSystem`** is stored metadata with no enforcement behavior in the library. Set it on seeded roles so your admin UI can recognize built-ins — for example, to hide the delete button on the `admin` group.

**`isActive`** is a kill switch. When a group's `isActive` is `false`, `getSubjectPolicies` excludes every grant that group provides — all its members lose those permissions in one write, while their direct policy assignments keep working. Use it when a role is compromised or misconfigured and you cannot wait to edit each member:

```ts
// Emergency: turn off every grant the "editor" group provides.
await rbac.adapter.upsertGroup({ name: 'editor', label: 'Editor', isActive: false })
await rbac.cache.clear() // drop cached policy maps so the change applies now
```

Members of a deactivated group are denied like any subject without the policy — 403 with `RBAC_POLICY_DENIED`:

```json
{
  "message": "Forbidden",
  "code": "RBAC_POLICY_DENIED"
}
```

Because `groups.ts` never sets `isActive`, running `rbac sync` again does not re-enable a group you deactivated: the omitted flag keeps its stored `false`. Reactivate it explicitly with `isActive: true`.

::: warning Cached decisions outlive the flip
Deactivation takes effect at the storage layer immediately, but each app instance serves cached policy maps until its cache TTL expires (30 seconds with the default memory cache). Call `rbac.cache.clear()` after flipping the flag, or keep the TTL short — see [Policy cache](/guide/caching).
:::

## What re-seeding does

Seeding is **replace-all per group**: for every group named in `groups.ts`, sync sets its policy entries to exactly the seed list — absent entries are removed, missing ones added, changed scopes updated. Groups not named in the file (for example roles your admin UI created at runtime) are never touched. This makes `groups.ts` the source of truth for the roles it defines: the file in git always matches what a deploy produces, regardless of what was clicked in a database UI in between.

Two consequences to plan around:

- Runtime edits to a *seeded* group's policy list are overwritten on the next sync. Roles that admins should edit live belong outside `groups.ts`.
- Seed lists do not need to repeat dependencies. After seeding, sync runs its [dependency back-fill](/guide/defining-policies#declaring-dependencies-with-dependson) against the seeded state, so granting `posts.create` in `groups.ts` fills `posts.view` into the group automatically (as an unrestricted grant — list it explicitly if it needs a scope).

::: warning Group names are global
Groups are keyed by name across the whole database, not per portal. If two portals both seed a group named `admin`, each portal's seed replaces the entries the other wrote — the last portal synced wins. Give groups portal-unique names (for example `admin` and `branch-admin`) when you run more than one portal.
:::

## Next steps

- [Syncing policies](/guide/syncing-policies) — the full sync pipeline and running it in CI.
- [Defining policies](/guide/defining-policies) — dependencies and scope options referenced by your seeds.
- [Error reference](/reference/errors) — every `RBAC_*` code and its status.
