# Core API

Reference for `@kyrobit/rbac`, the framework-agnostic core. Integrations live at subpaths: [Fastify](/reference/fastify), [Express](/reference/express), [Drizzle](/reference/drizzle), [Prisma](/reference/prisma), [Mongoose](/reference/mongoose), [Cache](/reference/cache), [Testing](/reference/testing).

## createRbac()

```ts
function createRbac(options: CreateRbacOptions): Rbac
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `adapter` | `StorageAdapter` | required | Storage backend. |
| `resources` | `ResourceDefinition[]` | `[]` | Your resource definitions. Declares your policies and scopes. |
| `cache` | `PolicyCache \| false` | in-memory | Policy cache. `false` disables caching. |
| `cacheTtlMs` | `number` | `30_000` | TTL for the default cache. Ignored when `cache` is set. |
| `cacheMaxEntries` | `number` | `10_000` | Size limit for the default cache. Ignored when `cache` is set. |
| `invalidationBus` | `InvalidationBus` | `inProcessBus()` | Cross-instance cache invalidation. |
| `db` | `unknown` | — | Db handle passed to scope checks. |
| `superBypass` | `boolean` | `true` | `is_super: true` users skip policy checks. |
| `onDecision` | `DecisionHook` | — | Fires on every allow/deny decision. |
| `onCacheEvent` | `CacheHook` | — | Fires on cache hits, misses and invalidations. |

```ts
import { createRbac, Policy, Scope } from '@kyrobit/rbac'
import { memoryAdapter } from '@kyrobit/rbac/testing'

const rbac = createRbac({
  adapter: memoryAdapter(),
  resources: [
    {
      type: 'post',
      policies: [
        new Policy('posts.read'),
        new Policy('posts.update', undefined, [], [Scope.owned()]),
      ],
    },
  ],
})
```

## Rbac

The instance returned by `createRbac()`.

| Member | Description |
| --- | --- |
| `engine` | The authorization engine (`RbacEngine`). |
| `adapter` | The adapter passed to `createRbac()`. |
| `resources` | The resource definitions passed to `createRbac()`. |
| `sync(resources, portal?)` | Sync policies into storage. Also available as [`rbac sync`](/reference/cli). |
| `seedGroups(groups, allPolicies?, portal?)` | Seed groups. Replaces each group's policies exactly. |
| `admin.assignGroup(subject, group)` | Assign a group. |
| `admin.removeGroup(subject, group)` | Remove a group. |
| `admin.assignPolicy(subject, policy, scope?)` | Grant one policy directly. |
| `admin.removePolicy(subject, policy)` | Remove a direct grant. |
| `ownership.record(owner, resource, context?)` | Record who owns a resource. |
| `ownership.isOwner(ownerId, resource)` | Check ownership. |
| `ownership.remove(resource)` | Remove all owners of a resource. |
| `ownership.addExtra(extra)` | Override the next tracked insert's ownership row. Applies once. See [Drizzle](/reference/drizzle). |
| `cache.invalidateSubject(subjectId)` | Drop one user's cached policies on every instance. |
| `cache.clear()` | Drop all cached policies on every instance. |
| `dispose()` | Detach bus subscriptions (shutdown, tests). |

`rbac.admin` is the low-level API. It takes qualified policy names — portal prefix included, like `admin.posts.read` — and an explicit portal/context:

```ts
interface AdminSubjectRef {
  subjectId: string
  portal?: string
  contextId?: string
}

await rbac.admin.assignPolicy({ subjectId: 'u1', portal: 'admin' }, 'admin.posts.read')
```

Portal instances offer the same methods with unqualified names. Prefer those in app code. See [Assigning access](/guide/assigning-access).

**Throws** `UnknownPolicyError` from `assignPolicy` when the policy was never synced.

## Policy

```ts
class Policy {
  constructor(
    name: string,          // unqualified, e.g. 'posts.read'
    label?: string,        // default: derived from the name
    dependsOn?: string[],  // policies this one requires
    scopeOptions?: Scope[] // scopes a grant may be restricted to
  )
}
```

```ts
const update = new Policy('posts.update', 'Update posts', ['posts.read'], [Scope.owned()])
```

See [Policies](/guide/policies).

## Scope

```ts
class Scope {
  constructor(name: string, label: string, check: ScopeCheckFn)
  static owned(name?: string, label?: string): Scope // built-in ownership check
}

type ScopeCheckFn = (
  subject: Subject,
  resource: ResourceRef,
  ctx: { db: unknown; adapter: StorageAdapter },
) => Awaitable<boolean>
```

A scope is a named row-level check. `Scope.owned()` allows a request only when the user owns the target resource. See [Scopes](/guide/scopes).

## Subject

The logged-in user, as guards see it. Your portal's `getSubject` callback returns this shape, minus `portal`. The portal fills `portal` in. See [Express](/reference/express) or [Fastify](/reference/fastify).

```ts
interface Subject {
  id: string
  portal?: string
  context_id?: string
  is_super?: boolean // skips all policy checks
  [key: string]: unknown
}
```

## Error classes

All guards throw subclasses of `RbacError`. Each carries `statusCode` and a stable `code`. `toBody()` returns `{ message, code }`. See [Errors](/reference/errors).

| Class | Status | Code |
| --- | --- | --- |
| `UnauthenticatedError` | 401 | `RBAC_UNAUTHENTICATED` |
| `PolicyDeniedError` | 403 | `RBAC_POLICY_DENIED` |
| `ScopeDeniedError` | 403 | `RBAC_SCOPE_DENIED` |
| `ResourceNotFoundError` | 404 | `RBAC_RESOURCE_NOT_FOUND` |
| `MisconfiguredError` | 500 | `RBAC_MISCONFIGURED` |

`UnknownPolicyError` is not an `RbacError`. Adapters throw it when `assignPolicy` targets an unsynced policy. It signals a setup problem, not a request denial.

## Other exports

Functions:

- `syncPolicies(adapter, resources, portal?, options?)` — sync one portal's policies into storage. `rbac.sync()` calls this. See [Sync](/guide/sync).
- `seedGroups(adapter, groups, allPolicies?, portal?)` — upsert groups and replace their policies. `rbac.seedGroups()` calls this.
- `backfillGroupDependencies(adapter, resources, portal?, options?)` — add missing policy dependencies to every group.
- `collectScopes(resources)` — build the scope registry from resource definitions. `createRbac()` calls this.
- `qualifyPolicyName(portal, policy)` — returns `` `${portal}.${policy}` ``, or `policy` when there is no portal.
- `toSubjectRef(subject)` — normalize a `Subject` into `{ subjectId, portal, contextId }`.
- `normalizeSentinel(value)` — returns `value ?? ''`. Storage stores `''`, never null, for a missing portal or context.
- `mergeGrants(grants)` — merge grant rows into a `PolicyMap`. An unrestricted grant wins over a scoped one.
- `defineConfig(config)` — returns `config` unchanged, with types. Use it in `rbac.config.ts`. See [Configuration](/reference/configuration).
- `createId()` — random string id generator (cuid2). Used by generated schemas.

Classes:

- `RbacEngine` — the decision engine behind every guard. Most apps never construct one.
- `SubjectStore` — per-request state holder, for custom framework integrations.

Types:

- Subjects: `Subject`, `SubjectInput`, `SubjectRef`.
- Policies: `ResourceDefinition`, `ContextPolicies`, `PolicyMap`, `ResourceRef`.
- Groups: `GroupsDefinition`, `GroupDefinition`, `GroupPoliciesInput`.
- Names: `RbacTypes`, `PortalName`, `AnyPolicyName`, `PortalPolicyName`, `QualifiedPolicyName`. See [TypeScript](/guide/typescript).
- Storage contract: `StorageAdapter`, `AdapterCapabilities`, `PolicyDefinitionRow`, `PolicyRecord`, `PolicyGrant`, `GroupRecord`, `GroupPolicyEntry`, `OwnershipEntry`. See [Custom adapters](/guide/custom-adapters).
- Cache: `PolicyCache`, `PolicyCacheKey`, `InvalidationBus`, `InvalidationEvent`, `CacheEvent`, `CacheHook`. See [Cache](/reference/cache).
- Hooks: `DecisionEvent`, `DecisionHook`, `RbacErrorCode`.
- Engine: `EngineOptions`, `AuthorizeOptions`, `RequestStore`, `ScopeCheckFn`, `ScopeCheckContext`, `Awaitable`.
- Config: `RbacConfig`, `PortalConfig`.
