# Migrating from v0

You move a v0 install to v1 in five steps: swap imports using the symbol table, rewire the app around `createRbac`, update assignment call sites, run one SQL migration against your Postgres database, then re-sync. v1 is a rewrite — a framework-agnostic core with integrations at subpaths — so every step below is mechanical but none is optional.

::: tip Prerequisites
Skim the [Quick start](/guide/quick-start) so the v1 shape (one `rbac` instance, portals as factories, guards that throw) is familiar, and [Configuration](/reference/configuration) for the new `rbac.config.ts`. v0 shipped a Postgres-only Drizzle schema, so the data migration in step 4 targets PostgreSQL.
:::

## 1. Update imports

v0 exported everything from the package root. v1 keeps the framework-agnostic core at `@kyrobit/rbac` and moves integrations to subpaths.

| v0 export (`@kyrobit/rbac`) | v1 equivalent | v1 import path |
| --- | --- | --- |
| `Policy` | `Policy` (unchanged) | `@kyrobit/rbac` |
| `Scope` | `Scope` — `check` now receives `(subject, resource, ctx)` where `ctx` is `{ db, adapter }`, not the raw db | `@kyrobit/rbac` |
| `ScopeCheckFn` | `ScopeCheckFn` (new signature, as above) | `@kyrobit/rbac` |
| `ScopeCondition` | `QueryScopeFn` | `@kyrobit/rbac/drizzle` |
| `ResourceDefinition` | `ResourceDefinition` — `table` is now optional | `@kyrobit/rbac` |
| `ContextPolicies` | `ContextPolicies` (unchanged) | `@kyrobit/rbac` |
| `Subject` | `Subject` (unchanged shape; `context_id` and `is_super` still recognized) | `@kyrobit/rbac` |
| `RbacTypes` | `RbacTypes` — now empty and augmented by the generated `rbac.d.ts`; consume it through `PortalName`, `AnyPolicyName`, `PortalPolicyName<P>` | `@kyrobit/rbac` |
| `RbacOptions` | `CreateRbacOptions` | `@kyrobit/rbac` |
| `RbacAdapter` | `StorageAdapter` (a different, larger contract — see [Writing a storage adapter](/guide/writing-a-storage-adapter)) | `@kyrobit/rbac` |
| `createDrizzleAdapter(db)` | `drizzleAdapter(db, { schema })` | `@kyrobit/rbac/drizzle` |
| `createTrackedDb(db, { resources })` | `trackedDb(db, { rbac, resources })` | `@kyrobit/rbac/drizzle` |
| `TrackedDbOptions` | `TrackedDbOptions` (now requires `rbac`) | `@kyrobit/rbac/drizzle` |
| `rbacPlugin` (register with `{ adapter, db }`) | `rbacFastify(rbac)` | `@kyrobit/rbac/fastify` |
| `RbacPluginOptions` | `CreateRbacOptions` + `RbacFastifyOptions` | `@kyrobit/rbac` / `@kyrobit/rbac/fastify` |
| `app.rbac.forPortal(name, getSubject)` | `app.rbac.portal(name, { getSubject })` | — |
| `app.rbac.requirePolicy(...)` (portal-less) | create a portal named `''` and use its `requirePolicy` | — |
| `app.rbac.setSubject(req, subject)` | `app.rbac.setSubject(subject)` (no request argument) | — |
| `app.rbac.clearPolicyCache(id?)` | `app.rbac.cache.invalidateSubject(id)` / `app.rbac.cache.clear()` | — |
| `clearPolicyCache(id?)` | `rbac.cache.invalidateSubject(id)` / `rbac.cache.clear()` | — |
| `addExtra(extra)` | `rbac.ownership.addExtra(extra)` (or `app.rbac.addExtra`) | `@kyrobit/rbac` |
| `setContext(subject, context)` | `app.rbac.setSubject(subject)` — context rides on `subject.context_id` | — |
| `syncPolicies(adapter, resources, portal?)` | `syncPolicies(adapter, resources, portal?)` or `rbac.sync(resources, portal?)` — but prefer `rbac sync` (CLI) | `@kyrobit/rbac` |
| `seedGroups(db, groups, allPolicies)` | `seedGroups(adapter, groups, allPolicies?, portal?)` or `rbac.seedGroups(...)` — takes the adapter, not the db | `@kyrobit/rbac` |
| `assignGroup(db, subjectId, groupId, opts)` | `portal.assignGroup(subjectId, groupName, opts)` or `rbac.admin.assignGroup(ref, groupName)` — takes the group **name**, not its row id | — |
| `removeGroup(db, ...)` | `portal.removeGroup(...)` / `rbac.admin.removeGroup(...)` | — |
| `assignPolicy(db, subjectId, name, { scope })` | `portal.assignPolicy(subjectId, unqualifiedName, { contextId, scope })` or `rbac.admin.assignPolicy(ref, qualifiedName, scope)` | — |
| `removePolicy(db, subjectId, name)` | `portal.removePolicy(...)` / `rbac.admin.removePolicy(...)` | — |
| `policies`, `policyGroups`, `policyGroupPolicies`, `userPolicyGroups`, `userPolicies`, `resourceOwners` (Drizzle tables) | `rbacPolicies`, `rbacPolicyGroups`, `rbacPolicyGroupPolicies`, `rbacUserPolicyGroups`, `rbacUserPolicies`, `rbacResourceOwners` (plus a `tables` barrel and `dialect`) | `@kyrobit/rbac/drizzle/schema/pg` |
| `RBAC_SCOPES` symbol (scope registry on the tracked db) | gone — `createRbac({ resources })` collects scopes from `scopeOptions` via `collectScopes` | `@kyrobit/rbac` |
| `GroupDefinition`, `GroupsDefinition`, `GroupPoliciesInput` | unchanged | `@kyrobit/rbac` |

New in v1 with no v0 counterpart: `createRbac`, the Express integration (`@kyrobit/rbac/express`), the Prisma adapter (`@kyrobit/rbac/prisma`), the Mongoose adapter (`@kyrobit/rbac/mongoose`), MySQL and SQLite schemas, the cache and invalidation-bus surface (`@kyrobit/rbac/cache`), typed errors, the testing kit (`@kyrobit/rbac/testing`) and the `init`/`generate`/`status` CLI commands.

## 2. Rewire the app

Construct one `rbac` instance and hand it to the framework integration. Portals are now hook-free factories with lazy subject resolution.

```ts
// v0
import Fastify from 'fastify'
import { rbacPlugin, createDrizzleAdapter } from '@kyrobit/rbac'
import { db } from './db/index.js'

const app = Fastify()
await app.register(rbacPlugin, { adapter: createDrizzleAdapter(db), db })

const admin = app.rbac.forPortal('admin', async req => ({
  id: req.headers['x-user-id'] as string,
}))
```

```ts
// v1
import Fastify from 'fastify'
import { createRbac } from '@kyrobit/rbac'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { drizzleAdapter } from '@kyrobit/rbac/drizzle'
import * as schema from '@kyrobit/rbac/drizzle/schema/pg'
import { db } from './db/index.js'
import { resources } from './rbac/policies.js'

const rbac = createRbac({
  adapter: drizzleAdapter(db, { schema }),
  resources, // the scope registry comes from here — omit it and every scoped grant denies
  db,        // handed to scope checks
})

const app = Fastify()
await app.register(rbacFastify(rbac))

const admin = app.rbac.portal('admin', {
  getSubject: async request => {
    const id = request.headers['x-user-id']
    return typeof id === 'string' ? { id } : null // null → 401
  },
})
```

`requirePolicy` usage on routes is unchanged (`{ preHandler: admin.requirePolicy('posts.read') }`), including the `resource` option for scoped grants. If you used `createTrackedDb` for ownership auto-tracking, replace it with `trackedDb(db, { rbac, resources })` and pass the tracked handle as `db` to `createRbac` — see [Tracking ownership](/guide/tracking-ownership).

Custom scope checks change signature — the db moves into a context object that also carries the adapter:

```ts
// v0: new Scope('branch', 'Same branch', async (subject, resource, db) => { ... })
// v1:
new Scope('branch', 'Same branch', async (subject, resource, ctx) => {
  const db = ctx.db // whatever you passed to createRbac
  // ctx.adapter powers portable checks, e.g. ctx.adapter.isOwner(...)
  return subject.branch_id === /* look the row up via db */ resource.id
})
```

## 3. Update assignment call sites

Assignments no longer take a db handle, and group assignment takes the group **name** where v0 took the group's row id:

```ts
// v0
await assignGroup(db, 'user-1', groupRowId, { portal: 'admin', contextId: 'branch-1' })
await assignPolicy(db, 'user-1', 'admin.posts.read', { scope: 'owned' })

// v1 — portal instance: unqualified names, portal filled in for you
await admin.assignGroup('user-1', 'editors', { contextId: 'branch-1' })
await admin.assignPolicy('user-1', 'posts.read', { scope: 'owned' })

// v1 — low-level admin API: fully-qualified names, explicit coordinates
await rbac.admin.assignPolicy(
  { subjectId: 'user-1', portal: 'admin', contextId: 'branch-1' },
  'admin.posts.read',
  'owned',
)
```

Every mutation now invalidates the subject's cached policy map and publishes on the invalidation bus, so the manual `clearPolicyCache()` calls that followed v0 assignments can be deleted.

## 4. Behavioral changes

::: warning Read this list before deploying — three of these change authorization outcomes
1. **Direct policy assignments are portal/context-scoped.** v0 matched `rbac_user_policies` on `subject_id` alone: a direct grant applied in every portal and every tenant context. v1 matches the full `(subject_id, portal, context_id)` tuple by strict equality. After migration, un-backfilled direct grants sit at `('', '')` and apply only to portal-less, context-less requests.
2. **Strict matching everywhere, via the `''` sentinel.** `portal` and `context_id` are `NOT NULL DEFAULT ''` and matched by plain equality — a grant with no context never applies to a request with one, and vice versa; this is what keeps tenant data isolated. v0's `NULL` semantics (and its cache key that collided across positions) are gone.
3. **Denials are thrown, not written to the raw socket.** v0's guard called `reply.hijack()` and wrote `{"message":"Forbidden"}` directly, skipping `onSend` hooks and CORS headers. v1 throws typed errors through the framework's own pipeline, and bodies carry a stable `code`. A v1 policy denial on Express is `403` with `{ "message": "Forbidden", "code": "RBAC_POLICY_DENIED" }`; Fastify's default serializer produces `{ "statusCode": 403, "code": "RBAC_POLICY_DENIED", "error": "Forbidden", "message": "Forbidden" }`. Update clients that parsed the v0 body shape — branch on `code`, not message.
4. **The policy cache is instance-scoped with automatic invalidation.** v0 kept one module-global, unbounded, TTL-less Map for the whole process. v1 creates a bounded LRU (10,000 entries, 30 s TTL by default) inside each `createRbac()` call, invalidates on every assignment mutation and publishes invalidations on a bus for other instances. Two apps in one process can no longer read each other's entries.
5. **Portal registration is hook-free.** v0's `forPortal` installed an app-wide `onRequest` hook per portal, so two portals overwrote each other's subject on every request. v1 resolves the subject lazily at guard time, memoized per request per portal.
6. **Orphan cleanup filters on the stored `portal` column.** v0 guessed a policy's portal by counting dots in its name, which could delete another portal's policies during sync. v1 stores `portal` on each policy row and deletes orphans only within the portal being synced.
:::

To see which direct grants change behavior, run this **before** migrating — every row it returns matched any portal and context in v0 and will match exactly one coordinate pair after migration:

```sql
SELECT up.subject_id, p.name AS policy, up.scope
FROM rbac_user_policies up
JOIN rbac_policies p ON p.id = up.policy_id
ORDER BY up.subject_id, p.name;
```

The migration below backfills each grant's `portal` from its policy's name prefix (a v0 direct grant referenced a qualified name like `admin.posts.read`, so the policy's portal is the portal it was used under). It cannot backfill `context_id` — v0 never recorded it. If your subjects authenticate with a `context_id`, re-issue those grants per context after migrating, or set `context_id` explicitly with an `UPDATE` you write for your own tenancy rules.

## 5. Migrate the database (PostgreSQL)

::: danger Back up first
Take a backup (`pg_dump`) and run this on a staging copy before production. The block deletes duplicate rows to make room for the new unique indexes and rewrites two column types. It runs in one transaction, so a failure rolls back cleanly — but only a backup protects you from a migration that succeeds and does the wrong thing for your data.
:::

```sql
BEGIN;

-- 1. rbac_policies: add the stored portal column (v1 filters orphan cleanup on it).
ALTER TABLE rbac_policies
  ADD COLUMN portal text NOT NULL DEFAULT '';

-- Derive each policy's portal from its qualified name prefix.
-- Repeat one UPDATE per portal in your rbac.config.ts; policies matching
-- no prefix stay at '' (portal-less).
UPDATE rbac_policies SET portal = 'admin' WHERE name LIKE 'admin.%';
-- UPDATE rbac_policies SET portal = 'branch' WHERE name LIKE 'branch.%';

-- 2. rbac_policy_groups: is_system / is_active were text 'true'/'false' in v0.
ALTER TABLE rbac_policy_groups
  ALTER COLUMN is_system DROP DEFAULT,
  ALTER COLUMN is_active DROP DEFAULT;
ALTER TABLE rbac_policy_groups
  ALTER COLUMN is_system TYPE boolean USING (is_system = 'true'),
  ALTER COLUMN is_active TYPE boolean USING (is_active = 'true');
ALTER TABLE rbac_policy_groups
  ALTER COLUMN is_system SET DEFAULT false,
  ALTER COLUMN is_active SET DEFAULT true;

-- 3. rbac_user_policy_groups: NULL → '' sentinel backfill, then NOT NULL.
UPDATE rbac_user_policy_groups SET portal = '' WHERE portal IS NULL;
UPDATE rbac_user_policy_groups SET context_id = '' WHERE context_id IS NULL;
ALTER TABLE rbac_user_policy_groups
  ALTER COLUMN portal SET DEFAULT '',
  ALTER COLUMN portal SET NOT NULL,
  ALTER COLUMN context_id SET DEFAULT '',
  ALTER COLUMN context_id SET NOT NULL;

-- 4. rbac_user_policies: direct grants become portal/context-scoped.
ALTER TABLE rbac_user_policies
  ADD COLUMN portal text NOT NULL DEFAULT '',
  ADD COLUMN context_id text NOT NULL DEFAULT '';

-- Backfill portal from the granted policy's own portal (derived in step 1).
UPDATE rbac_user_policies up
SET portal = p.portal
FROM rbac_policies p
WHERE p.id = up.policy_id AND p.portal <> '';

-- 5. rbac_resource_owners: NULL → '' sentinel backfill, then NOT NULL.
UPDATE rbac_resource_owners SET context_type = '' WHERE context_type IS NULL;
UPDATE rbac_resource_owners SET context_id = '' WHERE context_id IS NULL;
ALTER TABLE rbac_resource_owners
  ALTER COLUMN context_type SET DEFAULT '',
  ALTER COLUMN context_type SET NOT NULL,
  ALTER COLUMN context_id SET DEFAULT '',
  ALTER COLUMN context_id SET NOT NULL;

-- 6. Dedupe before adding the unique indexes. v0 had no unique constraints
-- on these tables, so repeated assigns and ownership writes created
-- duplicate rows that would make CREATE UNIQUE INDEX fail.

-- Group entries: one (group, policy) pair; prefer the unrestricted row.
DELETE FROM rbac_policy_group_policies
WHERE id NOT IN (
  SELECT DISTINCT ON (policy_group_id, policy_id) id
  FROM rbac_policy_group_policies
  ORDER BY policy_group_id, policy_id, (scope IS NULL) DESC, created_at, id
);

-- Group assignments: one (subject, group, portal, context) tuple.
DELETE FROM rbac_user_policy_groups
WHERE id NOT IN (
  SELECT DISTINCT ON (subject_id, policy_group_id, portal, context_id) id
  FROM rbac_user_policy_groups
  ORDER BY subject_id, policy_group_id, portal, context_id, created_at, id
);

-- Direct grants: one (subject, policy, portal, context) tuple. Keeping the
-- scope IS NULL row when duplicates disagree preserves effective access,
-- because an unrestricted grant wins over a scoped one at decision time.
DELETE FROM rbac_user_policies
WHERE id NOT IN (
  SELECT DISTINCT ON (subject_id, policy_id, portal, context_id) id
  FROM rbac_user_policies
  ORDER BY subject_id, policy_id, portal, context_id, (scope IS NULL) DESC, created_at, id
);

-- Ownership: one (resource_type, resource_id, owner_id) tuple.
DELETE FROM rbac_resource_owners
WHERE id NOT IN (
  SELECT DISTINCT ON (resource_type, resource_id, owner_id) id
  FROM rbac_resource_owners
  ORDER BY resource_type, resource_id, owner_id, created_at, id
);

-- 7. The v1 unique constraints and indexes.
CREATE UNIQUE INDEX rbac_pgp_group_policy_uq
  ON rbac_policy_group_policies (policy_group_id, policy_id);
CREATE UNIQUE INDEX rbac_upg_tuple_uq
  ON rbac_user_policy_groups (subject_id, policy_group_id, portal, context_id);
CREATE INDEX rbac_upg_subject_idx
  ON rbac_user_policy_groups (subject_id);
CREATE UNIQUE INDEX rbac_up_tuple_uq
  ON rbac_user_policies (subject_id, policy_id, portal, context_id);
CREATE INDEX rbac_up_subject_idx
  ON rbac_user_policies (subject_id);
CREATE UNIQUE INDEX rbac_ro_tuple_uq
  ON rbac_resource_owners (resource_type, resource_id, owner_id);
CREATE INDEX rbac_ro_resource_idx
  ON rbac_resource_owners (resource_type, resource_id);

COMMIT;
```

Column names are unchanged, so application queries against the rbac tables keep working at the SQL level. Only the Drizzle property names changed (`scopeOptions` for `scope_options`, `subjectId` for `subject_id`, ...) — update any code that queried the tables through the v0 exported table objects. The final schema this produces is documented in [Database schema](/reference/database-schema).

## 6. Re-sync and regenerate types

Write the new [`rbac.config.ts`](/reference/configuration) (or let `rbac init` scaffold it and merge your paths), then:

```sh
rbac sync
```

This upserts your policies (now recording `portal` on each row through the adapter), reseeds groups, back-fills group dependencies and rewrites `rbac.d.ts` in the v1 format. Replace the v0 generated file rather than keeping it alongside: in v0 the base `RbacTypes` interface already declared `Portal: string`, so its augmentation re-declared members; v1 ships the interface empty and the generated file adds the members (with every name JSON-escaped). Then typecheck: call sites still passing a db handle to assignment functions, or reading `RbacTypes['PolicyName']` directly, surface as compile errors with equivalents in the table above.

## Next steps

- [Protecting routes](/guide/protecting-routes) — the v1 decision table and all four denied responses.
- [Caching](/guide/caching) — TTLs, the invalidation bus and multi-instance setups.
- [Database schema](/reference/database-schema) — every constraint the migration created, and the invariant each enforces.
