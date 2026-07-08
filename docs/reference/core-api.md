# Core API

Reference for `@kyrobit/kyroguard`, the framework-agnostic core. Integrations live at subpaths: [Fastify](/reference/fastify), [Express](/reference/express), [Drizzle](/reference/drizzle), [Prisma](/reference/prisma), [Mongoose](/reference/mongoose), [Cache](/reference/cache), [Testing](/reference/testing).

## createGuard()

```ts
function createGuard(options: CreateGuardOptions): Guard
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `adapter` | `StorageAdapter` | required | Storage backend. |
| `policies` | `Policy[]` | `[]` | Plain policy list — what staff can do. Use it for guard-only apps. |
| `groups` | `GroupsDefinition` | — | Group definitions — job titles. `sync()` seeds them after policies. |
| `resources` | `ResourceDefinition[]` | `[]` | Resource definitions. Only needed for ownership tracking or list filtering. |
| `cache` | `PolicyCache \| false` | in-memory | Policy cache. `false` disables caching. |
| `cacheTtlMs` | `number` | `30_000` | TTL for the default cache. Ignored when `cache` is set. |
| `cacheMaxEntries` | `number` | `10_000` | Size limit for the default cache. Ignored when `cache` is set. |
| `invalidationBus` | `InvalidationBus` | `inProcessBus()` | Cross-instance cache invalidation. |
| `db` | `unknown` | — | Db handle passed to scope checks. |
| `superBypass` | `boolean` | `true` | `is_super: true` users skip policy checks. |
| `onDecision` | `DecisionHook` | — | Fires on every allow/deny decision. |
| `onCacheEvent` | `CacheHook` | — | Fires on cache hits, misses and invalidations. |

```ts
import { createGuard, Policy, Scope } from '@kyrobit/kyroguard'
import { memoryAdapter } from '@kyrobit/kyroguard/testing'

const guard = createGuard({
  adapter: memoryAdapter(),
  policies: [
    new Policy('grades.view', { scopeOptions: [Scope.inTenant()] }),
    new Policy('grades.enter', { dependsOn: ['grades.view'] }),
    new Policy('grades.update', { dependsOn: ['grades.view'], scopeOptions: [Scope.owned(), Scope.inTenant()] }),
    new Policy('grades.delete', { dependsOn: ['grades.view'], scopeOptions: [Scope.inTenant()] }),
  ],
  groups: {
    teacher: {
      label: 'Teacher',
      policies: { 'grades.view': 'in-tenant', 'grades.enter': 'all', 'grades.update': 'owned' },
    },
    coordinator: {
      label: 'Coordinator',
      policies: { 'grades.view': 'in-tenant', 'grades.update': 'in-tenant', 'grades.delete': 'in-tenant' },
    },
  },
})
await guard.sync()
```

## Guard

The instance returned by `createGuard()`.

| Member | Description |
| --- | --- |
| `engine` | The authorization engine (`GuardEngine`). |
| `adapter` | The adapter passed to `createGuard()`. |
| `resources` | The resource definitions, including the `policies` shorthand. |
| `resourceForPolicy` | Unqualified policy name → the resource that defines it. Guards resolve their filter target through it — see [`storeFilterFor`](#storefilterfor). |
| `sync()` | Load the `createGuard` policies and seed its groups. Same as [`kyroguard sync`](/reference/cli). |
| `sync(domain)` | The same, qualified under a domain name. |
| `sync(resources, domain?)` | Explicit form for multi-domain setups. Does not seed groups. |
| `seedGroups(groups, options?)` | Seed groups alone. Replaces each group's policies exactly. `options`: `domain`, `allPolicies`. |
| `admin.assignGroup(subject, group)` | Assign a group. |
| `admin.removeGroup(subject, group)` | Remove a group. |
| `admin.assignPolicy(subject, policy, scope?)` | Grant one policy directly. `scope` is a scope name; omitted or `'all'` means no restriction — every row. |
| `admin.removePolicy(subject, policy)` | Remove a direct grant. |
| `ownership.record(owner, resource, at?)` | Record who owns a resource (relation `'owner'`). `at`: `domain`, `tenantId`. |
| `ownership.isOwner(ownerId, resource)` | Check ownership. Matches only `'owner'` entries. |
| `ownership.remove(resource)` | Remove every entry for a resource — all users, all relations. |
| `ownership.addExtra(extra)` | Override the next tracked insert's ownership row. Applies once. See [Drizzle](/reference/drizzle). |
| `access.grant(userId, resource, options?)` | Grant a user access to a resource. Default relation `'granted'`. `options`: `relation`, `domain`, `tenantId`. |
| `access.revoke(userId, resource, relation?)` | Remove that user's entries for the resource. A relation narrows the removal to it. |
| `access.list(resource)` | Every access entry for the resource, all relations, as `OwnershipEntry[]`. |
| `cache.invalidateSubject(subjectId)` | Drop one user's cached policies on every instance. |
| `cache.clear()` | Drop all cached policies on every instance. |
| `dispose()` | Detach bus subscriptions (shutdown, tests). |

`guard.admin` is the low-level API. It takes qualified policy names — domain prefix included, like `admin.reports.view` — and an explicit domain/tenant:

```ts
interface AdminSubjectRef {
  subjectId: string
  domain?: string
  tenantId?: string
}

await guard.admin.assignPolicy({ subjectId: 'zainab', domain: 'admin' }, 'admin.reports.view')
```

Domain instances offer the same methods with unqualified names. Prefer those in app code. See [Assigning access](/guide/assigning-access).

**Throws** from `assignPolicy`: `UnknownPolicyError` when the policy was never synced, `UnknownScopeError` when the scope is not among the policy's `scopeOptions`. `'all'` is always accepted — it is the unrestricted marker, not a scope name.

## Policy

```ts
class Policy {
  constructor(name: string, options?: {
    label?: string         // default: the action, capitalized — 'grades.enter' → "Enter"
    dependsOn?: string[]   // policies this one requires
    scopeOptions?: Scope[] // scopes a grant may be restricted to
  })
  // positional form also accepted:
  constructor(name: string, label?: string, dependsOn?: string[], scopeOptions?: Scope[])
}
```

```ts
const updateGrades = new Policy('grades.update', { dependsOn: ['grades.view'], scopeOptions: [Scope.owned()] })
```

`scopeOptions` is enforced at grant time: `seedGroups` rejects a group entry whose scope the policy does not declare, and `assignPolicy` throws [`UnknownScopeError`](#error-classes). See [Policies](/guide/policies).

## ResourceDefinition

```ts
interface ResourceDefinition {
  type: string                     // resource name in scoped checks and the ownership store
  policies: Policy[]
  table?: unknown                  // Drizzle table or Mongoose model — read by trackedDb / the plugin
  fields?: Record<string, unknown> // abstract field name → native column, for resource-generic filters
}
```

The registration ties policies to rows. A guard whose policy appears in `policies` activates [automatic filtering](/guide/scopes#automatic-filtering) for this resource — reads of it apply that guard's grant for the rest of the request. Reads of an unregistered resource, or on a request no guard filtered, run plainly; lists outside a guard go through [`filterFor`](#filterfor) by hand.

## Scope

```ts
class Scope {
  constructor(name: string, label: string, check: ScopeCheckFn, filter?: ScopeFilterFn)
  static owned(name?: string, label?: string): Scope    // the user created the row
  static granted(name?: string, label?: string): Scope  // the row was granted to the user
  static inTenant(name?: string, label?: string): Scope // the row is in the subject's tenant
}

type ScopeCheckFn = (
  subject: Subject,
  resource: ResourceRef | null,
  ctx: ScopeCheckContext, // { db: unknown; adapter: StorageAdapter }
) => Awaitable<boolean>

type ScopeFilterFn = (
  subject: Subject,
  ctx: ScopeFilterContext, // ScopeCheckContext & { resource: ResourceDefinition }
) => Awaitable<ScopeFilterResult>

type ScopeFilterResult = boolean | { where: unknown }
```

A scope is a named condition on a grant — about the row (`Scope.owned()`: only grades the user entered) or about anything else (a date window, a published flag, a subject attribute). One scope owns both evaluation paths:

- `check` guards a single row. It receives the resource when the guard resolves one, or `null` — row scopes must fail closed on `null`.
- `filter` compiles the same condition for list queries. It returns `true` (no row restriction), `false` (no rows — fail closed), or `{ where }` — a native fragment for the app's ORM. Optional: a scope without one is folded through `check(subject, null, ctx)` on the list path, which makes condition scopes work in lists with no extra code and keeps filterless row scopes from leaking.

The built-ins ship both halves. Default names: `owned`, `granted`, `in-tenant`. The name `'all'` is reserved — it marks an unrestricted grant, and the constructor rejects it. See [Scopes](/guide/scopes).

## filterFor()

```ts
// On a domain instance (Fastify, Express):
teachers.filterFor(req, policy): Promise<FilterResult>

// On the engine:
guard.engine.filterFor(subject, qualifiedPolicy, resource: ResourceDefinition): Promise<FilterResult>

type FilterResult =
  | { kind: 'all' }
  | { kind: 'none'; reason: 'no-policy' | 'scope-denied' | 'unfilterable' }
  | { kind: 'where'; where: unknown }
```

The list-path counterpart of `requirePolicy`: same subject resolution, same grants, answered as a query plan instead of an allow/deny. The domain form locates the registered resource that defines the policy and throws `MisconfiguredError` when none does.

| Result | Meaning |
| --- | --- |
| `{ kind: 'all' }` | Query unfiltered — an unrestricted grant, a passing condition scope, or a superuser. |
| `{ kind: 'none', reason: 'no-policy' }` | The policy is not granted. Serve `[]`, or branch for a 403. |
| `{ kind: 'none', reason: 'scope-denied' }` | Every granted scope contributed nothing. Serve `[]` without querying. |
| `{ kind: 'none', reason: 'unfilterable' }` | Multiple fragments and the adapter cannot OR-combine them. Serve `[]`. |
| `{ kind: 'where', where }` | `AND` the fragment into your query. Native to the adapter: Drizzle SQL, Prisma `WhereInput`, Mongo filter. |

`filterFor` throws `UnauthenticatedError` for a missing subject — nothing else. A grant with several scopes ORs their fragments, and any scope answering `true` short-circuits to `all`. Worked examples in [Scopes](/guide/scopes#filtering-lists).

## storeFilterFor()

```ts
guard.engine.storeFilterFor(subject, qualifiedPolicy, resource: ResourceDefinition): Promise<FilterResult>
```

The guard-path entry behind [automatic filtering](/guide/scopes#automatic-filtering). After `requirePolicy` allows, the framework guard calls it with the policy it just checked and that policy's resource (from [`resourceForPolicy`](#kyroguard)): it runs [`filterFor`](#filterfor) and activates the result for the rest of the request, keyed by `resource.type`. `trackedDb`, the Prisma extension and the Mongoose plugin key their read filtering on that per-request state alone — a resource with no active filter is read unfiltered.

## GroupDefinition

```ts
type GroupsDefinition = Record<string, GroupDefinition>

interface GroupDefinition {
  label: string
  description?: string
  policies: 'all' | string[] | Record<string, string>
}
```

Groups are job titles: `teacher`, `coordinator`. `'all'` grants every synced policy. An array grants those policies, unrestricted. A record maps each policy to a scope; `'all'` means no restriction — every row. See [Groups](/guide/groups).

## Subject

The logged-in user, as guards see it. Your domain's `getSubject` callback returns this shape, minus `domain`. The domain fills `domain` in. See [Express](/reference/express) or [Fastify](/reference/fastify).

```ts
interface Subject {
  id: string
  domain?: string
  tenant_id?: string
  is_super?: boolean // skips all policy checks
  [key: string]: unknown
}
```

## Error classes

All guards throw subclasses of `GuardError`. Each carries `statusCode` and a stable `code`. `toBody()` returns `{ message, code }`, plus `reason` on the `ACCESS_DENIED` errors. See [Errors](/reference/errors).

| Class | Status | Code | `reason` |
| --- | --- | --- | --- |
| `UnauthenticatedError` | 401 | `UNAUTHENTICATED` | — |
| `PolicyDeniedError` | 403 | `ACCESS_DENIED` | `'policy'` |
| `ScopeDeniedError` | 403 | `ACCESS_DENIED` | `'scope'` |
| `ResourceNotFoundError` | 404 | `NOT_FOUND` | — |
| `MisconfiguredError` | 500 | `MISCONFIGURED` | — |

`UnknownPolicyError` and `UnknownScopeError` are not `GuardError`s. `assignPolicy` throws the first when the policy was never synced, the second when the grant carries a scope outside the policy's `scopeOptions`. Both signal a setup problem, not a request denial. See [Errors](/reference/errors).

## Other exports

Functions:

- `syncPolicies(adapter, resources, domain?, options?)` — sync one domain's policies into storage. `guard.sync()` calls this. See [Sync](/guide/sync).
- `seedGroups(adapter, groups, allPolicies?, domain?)` — upsert groups and replace their policies. `guard.seedGroups()` calls this.
- `backfillGroupDependencies(adapter, resources, domain?, options?)` — add missing policy dependencies to every group.
- `collectScopes(resources)` — build the scope registry from resource definitions. `createGuard()` calls this.
- `qualifyPolicyName(domain, policy)` — returns `` `${domain}.${policy}` ``, or `policy` when there is no domain.
- `toSubjectRef(subject)` — normalize a `Subject` into `{ subjectId, domain, tenantId }`.
- `normalizeSentinel(value)` — returns `value ?? ''`. Storage stores `''`, never null, for a missing domain or tenant.
- `mergeGrants(grants)` — merge grant rows into a `PolicyMap` (`Map<string, string[] | null>`). An unrestricted grant from anywhere wins the whole policy; otherwise the value is every granted scope name, deduped. Scopes OR on both paths: `authorize()` passes when any scope passes, `filterFor()` combines their fragments.
- `defineConfig(config)` — returns `config` unchanged, with types. Use it in `kyroguard.config.ts`. See [Configuration](/reference/configuration).
- `createId()` — random string id generator (cuid2). Used by generated schemas.

Classes:

- `GuardEngine` — the decision engine behind every guard. Most apps never construct one.
- `SubjectStore` — per-request state holder, for custom framework integrations.

Types:

- Subjects: `Subject`, `SubjectInput`, `SubjectRef`.
- Policies: `ResourceDefinition`, `PolicyMap`, `ResourceRef`.
- Groups: `GroupsDefinition`, `GroupDefinition`, `GroupPoliciesInput`.
- Names: `GuardTypes`, `DomainName`, `AnyPolicyName`, `DomainPolicyName`, `QualifiedPolicyName`. See [TypeScript](/guide/typescript).
- Storage contract: `StorageAdapter`, `AdapterCapabilities`, `ListFilters`, `PolicyDefinitionRow`, `PolicyRecord`, `PolicyGrant`, `GroupRecord`, `GroupPolicyEntry`, `OwnershipEntry`. See [Custom adapters](/guide/custom-adapters).
- Cache: `PolicyCache`, `PolicyCacheKey`, `InvalidationBus`, `InvalidationEvent`, `CacheEvent`, `CacheHook`. See [Cache](/reference/cache).
- Hooks: `DecisionEvent`, `DecisionHook`, `GuardErrorCode`.
- Engine: `EngineOptions`, `AuthorizeOptions`, `FilterResult`, `RequestStore`, `ScopeCheckFn`, `ScopeCheckContext`, `ScopeFilterFn`, `ScopeFilterContext`, `ScopeFilterResult`, `Awaitable`.
- Config: `GuardConfig`, `DomainConfig`.
