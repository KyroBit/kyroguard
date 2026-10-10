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
| `resources` | `ResourceDefinition[]` | `[]` | Resource definitions for a guard-level (single-domain) setup. Domains usually carry their own instead — `createDomain(guard, name, { resources })`. |
| `cache` | `PolicyCache \| false` | in-memory | Policy cache. `false` disables caching. |
| `cacheTtlMs` | `number` | `30_000` | TTL for the default cache. Ignored when `cache` is set. |
| `cacheMaxEntries` | `number` | `10_000` | Size limit for the default cache. Ignored when `cache` is set. |
| `invalidationBus` | `InvalidationBus` | `inProcessBus()` | Cross-instance cache invalidation. |
| `db` | `unknown` | — | Db handle passed to scopes. |
| `superBypass` | `boolean` | `true` | `is_super: true` users skip policy checks. |
| `onDecision` | `DecisionHook` | — | Fires on every allow/deny decision. |
| `onCacheEvent` | `CacheHook` | — | Fires on cache hits, misses and invalidations. |

```ts
import { createGuard, Policy } from '@kyrobit/kyroguard'
import { entered, inSchool } from './scopes.js'
import { memoryAdapter } from '@kyrobit/kyroguard/testing'

const guard = createGuard({
  adapter: memoryAdapter(),
  policies: [
    new Policy('grades.view', { scopeOptions: [inSchool] }),
    new Policy('grades.enter', { dependsOn: ['grades.view'] }),
    new Policy('grades.update', { dependsOn: ['grades.view'], scopeOptions: [entered, inSchool] }),
    new Policy('grades.delete', { dependsOn: ['grades.view'], scopeOptions: [inSchool] }),
  ],
  groups: {
    teacher: {
      label: 'Teacher',
      policies: { 'grades.view': 'in-school', 'grades.enter': 'all', 'grades.update': 'entered' },
    },
    coordinator: {
      label: 'Coordinator',
      policies: { 'grades.view': 'in-school', 'grades.update': 'in-school', 'grades.delete': 'in-school' },
    },
  },
})
await guard.sync()
```

## Guard

The instance returned by `createGuard()`.

| Member | Description |
| --- | --- |
| `engine` | The authorization engine (`GuardEngine`) — also [`can()`](#can) and [`grantsFor()`](#grantsfor) outside a request. |
| `adapter` | The adapter passed to `createGuard()`. |
| `resources` | All resource definitions: constructor ones plus everything domains registered. |
| `registerResources(domain, resources)` | Attach a domain's resources. `createDomain` calls this for you when given `resources`. |
| `resourceForPolicy` | Unqualified policy name → the resource that defines it. Guards resolve their filter target through it — see [`storeFilterFor`](#storefilterfor). |
| `sync()` | Load the `createGuard` policies and seed its groups. Same as [`kyroguard sync`](/reference/cli). |
| `sync(domain)` | The same, qualified under a domain name. |
| `sync(resources, domain?)` | Explicit form for multi-domain setups. Does not seed groups. |
| `seedGroups(groups, options?)` | Seed groups alone. Replaces each group's policies exactly. `options`: `domain`, `allPolicies`. |
| `cache.invalidateSubject(subjectId)` | Drop one user's cached policies on every instance. |
| `cache.clear()` | Drop all cached policies on every instance. |
| `dispose()` | Detach bus subscriptions (shutdown, tests). |

Assignment lives on the domain — `teachers.assignGroup(...)`, `teachers.assignPolicy(...)` — which supplies its own name and policy prefix. Domains are plain exported values, so scripts and seeders import them too. See [Assigning access](/guide/assigning-access).

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
const updateGrades = new Policy('grades.update', { dependsOn: ['grades.view'], scopeOptions: [entered] })
```

`scopeOptions` is enforced at grant time: `seedGroups` rejects a group entry whose scope the policy does not declare, and `assignPolicy` throws [`UnknownScopeError`](#error-classes). See [Policies](/guide/policies).

## ResourceDefinition

```ts
interface ResourceDefinition {
  type: string                     // resource name a scope applies to
  policies: Policy[]
  table?: unknown                  // Drizzle table or Mongoose model — read by scopedDb / the plugin
}
```

A scope reaches the table through `ctx.resource.table`, so a scope written against a conventional column (`businessId`, `ownerId`) works for every resource that has one — there is nothing per-resource to declare, and nothing to forget.

The registration ties policies to rows. A guard whose policy appears in `policies` activates [automatic filtering](/guide/scopes#automatic-filtering) for this resource — queries against it carry that guard's grant for the rest of the request. Queries against an unregistered resource, or on a request no guard filtered, run plainly; lists outside a guard go through [`filterFor`](#filterfor) by hand.

## Scope

```ts
class Scope {
  constructor(name: string, label: string, match: ScopeFn)
  constructor(name: string, label: string, definition: { match: ScopeFn; insert?: ScopeInsertFn })
}

type ScopeFn = (
  subject: Subject,
  ctx: ScopeContext, // { db: unknown; adapter: StorageAdapter; resource: ResourceDefinition }
) => Awaitable<ScopeResult>

type ScopeResult = boolean | { where: unknown }

type ScopeInsertFn = (subject: Subject, ctx: ScopeContext) => Awaitable<Record<string, unknown>>
```

A scope is a named condition on a grant, written against your own tables.

**`match`** decides which rows. It returns `true` (every row), `false` (no rows — fail closed), or `{ where }` — a native fragment for your ORM. The integration ANDs that fragment into every query for the resource: reads, updates and deletes alike, so there is no separate single-row check.

**`insert`** decides what a row created under this grant must carry. It returns the columns to stamp, so the same fact is declared once and used both ways:

```ts
new Scope('in-business', 'This business', {
  match: (subject, ctx) => ({ where: eq(transactions.businessId, subject.tenant_id) }),
  insert: subject => ({ businessId: subject.tenant_id }),
})
```

An insert that names one of those columns with a **different** value throws: the row would land where its creator's own `match` cannot read it. Passing the same value is fine. Two granted scopes stamping one column with different values is a `MisconfiguredError`.

kyroguard ships no built-in scopes; it has no table of its own describing your rows. The name `'all'` is reserved — it marks an unrestricted grant, and the constructor rejects it. See [Scopes](/guide/scopes).

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
| `{ kind: 'none', reason: 'scope-denied' }` | Every granted scope returned `false`. Serve `[]` without querying. |
| `{ kind: 'none', reason: 'unfilterable' }` | Multiple fragments and the adapter cannot OR-combine them. Serve `[]`. |
| `{ kind: 'where', where }` | `AND` the fragment into your query. Native to the adapter: Drizzle SQL, Prisma `WhereInput`, Mongo filter. |

`filterFor` throws `UnauthenticatedError` for a missing subject — nothing else. A grant with several scopes ORs their fragments, and any scope answering `true` short-circuits to `all`. Worked examples in [Scopes](/guide/scopes#when-you-want-the-condition-in-hand).

## can()

```ts
// On a domain instance (Fastify, Express):
teachers.can(req, policy): Promise<boolean>

// On the engine:
guard.engine.can(subject, qualifiedPolicy): Promise<boolean>
```

The non-throwing counterpart of `requirePolicy`, for deciding what to render. It answers the same question a guard answers — does this subject hold this policy? — as a boolean instead of a status code.

| Subject | Answer |
| --- | --- |
| No subject | `false` — never an `UnauthenticatedError` |
| Holds the policy | `true` |
| Holds it under a scope | `true` — a scoped grant is a grant |
| Does not hold it | `false` |
| `is_super` (with `superBypass`) | `true` |

```ts
app.get('/grades/:id', { preHandler: teachers.requirePolicy('grades.view') }, async req => ({
  grade: await loadGrade(req.params.id),
  // The screen hides its own Delete button; the DELETE route still guards itself.
  canDelete: await teachers.can(req, 'grades.delete'),
}))
```

`can()` emits no [decision event](#createguard). A capability query is not an access attempt, so it never reaches the audit hook — only real guard and list decisions do.

::: warning `can()` renders, it does not protect
Deciding what to show is not deciding what to allow. Every route still needs its own `requirePolicy` — a client can call the endpoint whatever the UI drew.
:::

## grantsFor()

```ts
// On a domain instance (Fastify, Express):
teachers.grantsFor(req): Promise<DomainGrants>

// On the engine (qualified names, no domain filtering):
guard.engine.grantsFor(subject, allPolicies?): Promise<PolicyMap>

type DomainGrants = Record<string, string[] | null>
```

Every policy the subject holds in this domain, in one round trip — enough for a client to render its whole navigation without asking per button.

Names come back **unqualified**, matching what you write on routes. Each value is `null` for an unrestricted grant, or the granted [scope](/guide/scopes) names:

```ts
app.get('/me/permissions', async req => teachers.grantsFor(req))
```

```json
{ "grades.view": null, "grades.update": ["entered"] }
```

| Subject | Answer |
| --- | --- |
| No subject | `{}` |
| Ordinary subject | Only this domain's grants — another domain's never appear |
| `is_super` (with `superBypass`) | Every policy the domain defines, each `null` |

A superuser holds no grant rows, so the bypass is expanded against the domain's own resources — otherwise an owner would come back as `{}` and every button would render hidden. On the engine form that universe is the `allPolicies` argument; the domain form supplies it for you.

## storeFilterFor()

```ts
guard.engine.storeFilterFor(subject, qualifiedPolicy, resource: ResourceDefinition): Promise<FilterResult>
```

The guard-path entry behind [automatic filtering](/guide/scopes#automatic-filtering). After `requirePolicy` allows, the framework guard calls it with the policy it just checked and that policy's resource (from [`resourceForPolicy`](#kyroguard)): it runs [`filterFor`](#filterfor) and activates the result for the rest of the request, keyed by `resource.type`. `scopedDb`, the Prisma extension and the Mongoose plugin key their read filtering on that per-request state alone — a resource with no active filter is read unfiltered.

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

All guards throw subclasses of `GuardError`. Each carries `statusCode` and a stable `code`. `toBody()` returns `{ message, code }`. See [Errors](/reference/errors).

| Class | Status | Code |
| --- | --- | --- |
| `UnauthenticatedError` | 401 | `UNAUTHENTICATED` |
| `PolicyDeniedError` | 403 | `ACCESS_DENIED` |
| `MisconfiguredError` | 500 | `MISCONFIGURED` |

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
- `mergeGrants(grants)` — merge grant rows into a `PolicyMap` (`Map<string, string[] | null>`). An unrestricted grant from anywhere wins the whole policy; otherwise the value is every granted scope name, deduped. `filterFor()` unions their fragments.
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
- Storage contract: `StorageAdapter`, `AdapterCapabilities`, `ListFilters`, `PolicyDefinitionRow`, `PolicyRecord`, `PolicyGrant`, `GroupRecord`, `GroupPolicyEntry`. See [Custom adapters](/guide/custom-adapters).
- Cache: `PolicyCache`, `PolicyCacheKey`, `InvalidationBus`, `InvalidationEvent`, `CacheEvent`, `CacheHook`. See [Cache](/reference/cache).
- Hooks: `DecisionEvent`, `DecisionHook`, `GuardErrorCode`.
- Engine: `EngineOptions`, `FilterResult`, `RequestStore`, `ScopeFn`, `ScopeContext`, `ScopeResult`, `Awaitable`.
- Config: `GuardConfig`, `DomainConfig`.
