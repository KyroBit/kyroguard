# Core API

Reference for `@kyrobit/rbac`, the framework-agnostic core. Integrations live at subpaths: [Fastify](/reference/fastify), [Express](/reference/express), [Drizzle](/reference/drizzle), [Prisma](/reference/prisma), [Mongoose](/reference/mongoose), [Cache](/reference/cache), [Testing](/reference/testing).

## createRbac()

```ts
function createRbac(options: CreateRbacOptions): Rbac
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
import { createRbac, Policy, Scope } from '@kyrobit/rbac'
import { memoryAdapter } from '@kyrobit/rbac/testing'

const rbac = createRbac({
  adapter: memoryAdapter(),
  policies: [
    new Policy('sales.view'),
    new Policy('sales.create', { dependsOn: ['sales.view'] }),
    new Policy('sales.void', { dependsOn: ['sales.view'], scopeOptions: [Scope.owned()] }),
  ],
  groups: {
    cashier: {
      label: 'Cashier',
      policies: { 'sales.view': 'owned', 'sales.create': null, 'sales.void': 'owned' },
    },
    manager: { label: 'Manager', policies: 'all' },
  },
})
await rbac.sync()
```

## Rbac

The instance returned by `createRbac()`.

| Member | Description |
| --- | --- |
| `engine` | The authorization engine (`RbacEngine`). |
| `adapter` | The adapter passed to `createRbac()`. |
| `resources` | The resource definitions, including the `policies` shorthand. |
| `sync()` | Load the `createRbac` policies and seed its groups. Same as [`rbac sync`](/reference/cli). |
| `sync(domain)` | The same, qualified under a domain name. |
| `sync(resources, domain?)` | Explicit form for multi-domain setups. Does not seed groups. |
| `seedGroups(groups, options?)` | Seed groups alone. Replaces each group's policies exactly. `options`: `domain`, `allPolicies`. |
| `admin.assignGroup(subject, group)` | Assign a group. |
| `admin.removeGroup(subject, group)` | Remove a group. |
| `admin.assignPolicy(subject, policy, scope?)` | Grant one policy directly. |
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

`rbac.admin` is the low-level API. It takes qualified policy names — domain prefix included, like `admin.reports.view` — and an explicit domain/tenant:

```ts
interface AdminSubjectRef {
  subjectId: string
  domain?: string
  tenantId?: string
}

await rbac.admin.assignPolicy({ subjectId: 'amina', domain: 'admin' }, 'admin.reports.view')
```

Domain instances offer the same methods with unqualified names. Prefer those in app code. See [Assigning access](/guide/assigning-access).

**Throws** `UnknownPolicyError` from `assignPolicy` when the policy was never synced.

## Policy

```ts
class Policy {
  constructor(name: string, options?: {
    label?: string         // default: the action, capitalized — 'sales.create' → "Create"
    dependsOn?: string[]   // policies this one requires
    scopeOptions?: Scope[] // scopes a grant may be restricted to
  })
  // positional form also accepted:
  constructor(name: string, label?: string, dependsOn?: string[], scopeOptions?: Scope[])
}
```

```ts
const voidSale = new Policy('sales.void', { dependsOn: ['sales.view'], scopeOptions: [Scope.owned()] })
```

See [Policies](/guide/policies).

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

A scope is a named condition on a grant — about the row (`Scope.owned()`: only sales the user recorded) or about anything else (time of day, an amount, a subject attribute). One scope owns both evaluation paths:

- `check` guards a single row. It receives the resource when the guard resolves one, or `null` — row scopes must fail closed on `null`.
- `filter` compiles the same condition for list queries. It returns `true` (no row restriction), `false` (no rows — fail closed), or `{ where }` — a native fragment for the app's ORM. Optional: a scope without one is folded through `check(subject, null, ctx)` on the list path, which makes condition scopes work in lists with no extra code and keeps filterless row scopes from leaking.

The built-ins ship both halves. Default names: `owned`, `granted`, `in-tenant`. See [Scopes](/guide/scopes).

## filterFor()

```ts
// On a domain instance (Fastify, Express):
staff.filterFor(req, policy): Promise<FilterResult>

// On the engine:
rbac.engine.filterFor(subject, qualifiedPolicy, resource: ResourceDefinition): Promise<FilterResult>

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

## GroupDefinition

```ts
type GroupsDefinition = Record<string, GroupDefinition>

interface GroupDefinition {
  label: string
  description?: string
  policies: 'all' | string[] | Record<string, string | null>
}
```

Groups are job titles: `cashier`, `manager`. `'all'` grants every synced policy. An array grants those policies, unrestricted. A record maps each policy to a scope; `null` means unrestricted. See [Groups](/guide/groups).

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

- `syncPolicies(adapter, resources, domain?, options?)` — sync one domain's policies into storage. `rbac.sync()` calls this. See [Sync](/guide/sync).
- `seedGroups(adapter, groups, allPolicies?, domain?)` — upsert groups and replace their policies. `rbac.seedGroups()` calls this.
- `backfillGroupDependencies(adapter, resources, domain?, options?)` — add missing policy dependencies to every group.
- `collectScopes(resources)` — build the scope registry from resource definitions. `createRbac()` calls this.
- `qualifyPolicyName(domain, policy)` — returns `` `${domain}.${policy}` ``, or `policy` when there is no domain.
- `toSubjectRef(subject)` — normalize a `Subject` into `{ subjectId, domain, tenantId }`.
- `normalizeSentinel(value)` — returns `value ?? ''`. Storage stores `''`, never null, for a missing domain or tenant.
- `mergeGrants(grants)` — merge grant rows into a `PolicyMap` (`Map<string, string[] | null>`). An unrestricted grant (`null`) from anywhere wins the whole policy; otherwise the value is every granted scope name, deduped. Scopes OR on both paths: `authorize()` passes when any scope passes, `filterFor()` combines their fragments.
- `defineConfig(config)` — returns `config` unchanged, with types. Use it in `rbac.config.ts`. See [Configuration](/reference/configuration).
- `createId()` — random string id generator (cuid2). Used by generated schemas.

Classes:

- `RbacEngine` — the decision engine behind every guard. Most apps never construct one.
- `SubjectStore` — per-request state holder, for custom framework integrations.

Types:

- Subjects: `Subject`, `SubjectInput`, `SubjectRef`.
- Policies: `ResourceDefinition`, `PolicyScopeMap`, `PolicyMap`, `ResourceRef`.
- Groups: `GroupsDefinition`, `GroupDefinition`, `GroupPoliciesInput`.
- Names: `RbacTypes`, `DomainName`, `AnyPolicyName`, `DomainPolicyName`, `QualifiedPolicyName`. See [TypeScript](/guide/typescript).
- Storage contract: `StorageAdapter`, `AdapterCapabilities`, `ListFilters`, `PolicyDefinitionRow`, `PolicyRecord`, `PolicyGrant`, `GroupRecord`, `GroupPolicyEntry`, `OwnershipEntry`. See [Custom adapters](/guide/custom-adapters).
- Cache: `PolicyCache`, `PolicyCacheKey`, `InvalidationBus`, `InvalidationEvent`, `CacheEvent`, `CacheHook`. See [Cache](/reference/cache).
- Hooks: `DecisionEvent`, `DecisionHook`, `RbacErrorCode`.
- Engine: `EngineOptions`, `AuthorizeOptions`, `FilterResult`, `RequestStore`, `ScopeCheckFn`, `ScopeCheckContext`, `ScopeFilterFn`, `ScopeFilterContext`, `ScopeFilterResult`, `Awaitable`.
- Config: `RbacConfig`, `DomainConfig`.
