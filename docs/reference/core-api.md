# Core API

Reference for the framework-agnostic core, `@kyrobit/rbac`. This entry point imports nothing from Fastify, Express, Drizzle, Prisma or Mongoose — integrations live at subpaths ([Fastify](/reference/fastify), [Express](/reference/express), [Drizzle](/reference/drizzle), [Prisma](/reference/prisma), [Mongoose](/reference/mongoose), [Cache](/reference/cache), [Testing](/reference/testing)).

## createRbac()

```ts
function createRbac(options: CreateRbacOptions): Rbac
```

Creates the rbac instance your app builds once and hands to a framework integration.

### CreateRbacOptions

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `adapter` | `StorageAdapter` | required | Storage backend. See [StorageAdapter](#storageadapter). |
| `resources` | `ResourceDefinition[]` | `[]` | Resource definitions — the source of the scope registry and tracking config. |
| `cache` | `PolicyCache \| false` | bounded in-memory LRU | Policy cache. Pass `false` to disable caching entirely. |
| `cacheTtlMs` | `number` | `30_000` | TTL for the default memory cache. Ignored when `cache` is provided. |
| `cacheMaxEntries` | `number` | `10_000` | Max entries for the default memory cache. Ignored when `cache` is provided. |
| `invalidationBus` | `InvalidationBus` | `inProcessBus()` | Cross-instance cache invalidation. |
| `db` | `unknown` | `undefined` | Db handle passed through to scope checks (use the tracked db if you have one). |
| `superBypass` | `boolean` | `true` | Whether `is_super: true` subjects bypass policy checks. |
| `onDecision` | `DecisionHook` | — | Audit hook — fires on every allow/deny decision. |
| `onCacheEvent` | `CacheHook` | — | Metrics hook — cache hits, misses and invalidations. |

**Returns** `Rbac`.

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

| Member | Type / signature | Description |
| --- | --- | --- |
| `engine` | `RbacEngine` | The authorization engine. Read-only. |
| `adapter` | `StorageAdapter` | The adapter passed to `createRbac()`. Read-only. |
| `resources` | `ResourceDefinition[]` | The resource definitions passed to `createRbac()`. Read-only. |
| `sync` | `(resources: ResourceDefinition[], portal?: string) => Promise<void>` | Sync policies-as-code into storage. Calls `adapter.ensureSchema?.()` first, then [`syncPolicies()`](#syncpolicies). Also available via the [`rbac sync` CLI](/reference/cli). |
| `seedGroups` | `(groups: GroupsDefinition, allPolicies?: { name: string }[], portal?: string) => Promise<void>` | Seed policy groups (replace-all per group). See [seedGroups()](#seedgroups). |
| `dispose` | `() => void` | Detach the engine's bus subscription (graceful shutdown, tests). |

### rbac.admin

Low-level assignment API. Takes **fully-qualified** policy names (`admin.posts.read`, not `posts.read`) and an explicit portal/context — portal instances in the framework layer offer the auto-prefixed form, so prefer those in app code. Every mutation invalidates the subject's cached policy map and publishes on the invalidation bus.

```ts
interface AdminSubjectRef {
  subjectId: string
  portal?: string    // '' when omitted
  contextId?: string // '' when omitted
}
```

| Method | Signature |
| --- | --- |
| `assignGroup` | `(subject: AdminSubjectRef, group: string) => Promise<void>` |
| `removeGroup` | `(subject: AdminSubjectRef, group: string) => Promise<void>` |
| `assignPolicy` | `(subject: AdminSubjectRef, policy: QualifiedPolicyName, scope?: string \| null) => Promise<void>` |
| `removePolicy` | `(subject: AdminSubjectRef, policy: QualifiedPolicyName) => Promise<void>` |

**Throws** `UnknownPolicyError` from `assignPolicy` when the policy has not been synced.

::: warning
Grants are matched by strict equality on `(portal, contextId)` — a grant made with no context never applies to a request that carries one, and vice versa. This is what keeps tenant data isolated, so pass the exact coordinates the request will use.
:::

### rbac.ownership

Portable ownership API — identical behavior on every storage backend.

| Method | Signature | Description |
| --- | --- | --- |
| `record` | `(owner: Subject \| string, resource: ResourceRef, context?: { portal?: string; contextId?: string }) => Promise<void>` | Upsert an ownership row. When `owner` is a `Subject`, its `portal`/`context_id` fill the context unless `context` overrides them; missing values store the `''` sentinel. |
| `isOwner` | `(ownerId: string, resource: ResourceRef) => Promise<boolean>` | Exact `(ownerId, type, id)` match. |
| `remove` | `(resource: ResourceRef) => Promise<void>` | Removes all owners of the resource. |
| `addExtra` | `(extra: Record<string, unknown>) => void` | One-shot overrides for the next tracked insert in this request. Consumed by [`trackedDb`](/reference/drizzle#trackeddb) (Drizzle); string values for `resourceType`, `resourceId`, `ownerId`, `contextType`, `contextId` replace the auto-derived ownership fields. Other keys and non-string values are ignored. |

### rbac.cache

| Method | Signature | Description |
| --- | --- | --- |
| `invalidateSubject` | `(subjectId: string) => Promise<void>` | Drop the subject's cached policy maps locally and publish on the bus. |
| `clear` | `() => Promise<void>` | Drop every cached policy map locally and publish `{ type: 'all' }`. |

## Policy

```ts
class Policy {
  constructor(
    name: string,
    label?: string,
    dependsOn: string[] = [],
    scopeOptions: Scope[] = [],
  )
  readonly name: string
  readonly label: string
  readonly dependsOn: string[]
  readonly scopeOptions: Scope[]
}
```

| Parameter | Description |
| --- | --- |
| `name` | Unqualified policy name, e.g. `posts.read`. The engine qualifies it with the portal at sync and guard time. |
| `label` | Human-readable label. Default: the last dot segment of `name` with dashes replaced by spaces (`posts.read-all` → `read all`). |
| `dependsOn` | Unqualified names of policies this one requires. `sync` back-fills missing dependencies into groups. |
| `scopeOptions` | Scopes a grant of this policy may be restricted to. |

```ts
import { Policy, Scope } from '@kyrobit/rbac'

const update = new Policy('posts.update', 'Update posts', ['posts.read'], [Scope.owned()])
```

## Scope

```ts
class Scope {
  constructor(name: string, label: string, check: ScopeCheckFn)
  readonly name: string
  readonly label: string
  readonly check: ScopeCheckFn
  static owned(name = 'owned', label = 'Owned by the user'): Scope
}

type ScopeCheckFn = (
  subject: Subject,
  resource: ResourceRef,
  ctx: ScopeCheckContext,
) => Awaitable<boolean>

interface ScopeCheckContext {
  db: unknown            // the db handle passed to createRbac (tracked or raw)
  adapter: StorageAdapter
}
```

A named row-level check. When a grant carries a scope, the guard resolves the target resource and the scope's `check` decides allow/deny. `Scope.owned()` is the built-in ownership scope, backed by `adapter.isOwner()` — identical behavior on every backend.

```ts
import { Scope } from '@kyrobit/rbac'

const owned = Scope.owned()
const sameBranch = new Scope('same-branch', 'Same branch', async (subject, resource, ctx) => {
  return ctx.adapter.isOwner(subject.id, resource) // or query ctx.db
})
```

## collectScopes()

```ts
function collectScopes(
  resources: Iterable<{ policies: { scopeOptions: Scope[] }[] }>,
): Map<string, Scope>
```

Collects the scope registry from resource definitions — every `Scope` found in any policy's `scopeOptions`, keyed by scope name. `createRbac()` calls this for you.

## RbacEngine

Framework-free authorization engine. Guards call `authorize()`; it either resolves (allow) or throws a typed `RbacError` (deny). Most apps never construct one directly — `createRbac()` does.

```ts
class RbacEngine {
  constructor(options: EngineOptions)
  readonly store: SubjectStore
}

interface EngineOptions {
  adapter: StorageAdapter
  scopes: Map<string, Scope>
  cache: PolicyCache | null   // null disables caching entirely
  bus: InvalidationBus
  db?: unknown
  superBypass?: boolean       // default true
  onDecision?: DecisionHook
  onCacheEvent?: CacheHook
}

interface AuthorizeOptions {
  resource?: () => Awaitable<ResourceRef | null | undefined>
}
```

| Method | Signature | Description |
| --- | --- | --- |
| `authorize` | `(subject: Subject \| null \| undefined, policy: QualifiedPolicyName, options?: AuthorizeOptions) => Promise<void>` | The decision procedure. Resolves on allow; throws on deny (see below). |
| `getPolicyMap` | `(ref: SubjectRef) => Promise<{ map: PolicyMap; cacheHit: boolean }>` | Resolve the subject's merged policy map, via cache when enabled. |
| `runWithRequestContext` | `<T>(fn: () => T) => T` | Run `fn` inside a fresh per-request store. |
| `setRequestSubject` | `(subject: Subject) => void` | Set the active subject on the current request store. |
| `assignGroup` / `removeGroup` | `(ref: SubjectRef, groupName: string) => Promise<void>` | Adapter mutation + subject invalidation + bus publish. |
| `assignPolicy` | `(ref: SubjectRef, policyName: QualifiedPolicyName, scope?: string \| null) => Promise<void>` | Same, for a direct grant. |
| `removePolicy` | `(ref: SubjectRef, policyName: QualifiedPolicyName) => Promise<void>` | Same. |
| `invalidateSubject` | `(subjectId: string) => Promise<void>` | Invalidate locally, publish `{ type: 'subject', subjectId }`. |
| `clearCache` | `() => Promise<void>` | Clear locally, publish `{ type: 'all' }`. |
| `getAdapter` | `() => StorageAdapter` | The adapter. |
| `getDb` | `() => unknown` | The db handle handed to scope checks. |
| `qualify` | `(portal: string, policy: string) => QualifiedPolicyName` | Same as [`qualifyPolicyName()`](#qualifypolicyname). |
| `dispose` | `() => void` | Detach the bus subscription. |

`authorize()` throws:

| Condition | Error | Status |
| --- | --- | --- |
| No subject or empty subject id | `UnauthenticatedError` | 401 |
| Policy not granted at this exact `(portal, contextId)` | `PolicyDeniedError` | 403 |
| Scoped grant and the scope check rejected, or the scope object or `resource` resolver is missing | `ScopeDeniedError` | 403 |
| Scoped grant and the `resource` resolver returned `null`/`undefined` | `ResourceNotFoundError` | 404 |

A missing scope object or missing resolver on a scoped grant is a deny, never a bypass — a grant restricted to "owned" rows must not widen to all rows because of a wiring gap.

### mergeGrants()

```ts
function mergeGrants(grants: PolicyGrant[]): PolicyMap
```

Merges duplicate grant rows into one entry per policy: a `null` scope (unrestricted) wins over any named scope; between two different named scopes the first row wins. Deterministic because adapters return rows in stable order (group grants first, then direct grants, each sorted by name).

## SubjectStore

Instance-scoped `AsyncLocalStorage` wrapper holding per-request state. Each engine owns its own store, so two engines in one process never leak context into each other. Framework integrations manage it for you; it is public for custom integrations.

```ts
interface RequestStore {
  subject: Subject | null
  portalSubjects: Map<string, Subject | null>
  extraOnce: Record<string, unknown> | null
}
```

| Method | Signature | Description |
| --- | --- | --- |
| `run` | `<T>(fn: () => T) => T` | Run `fn` inside a fresh store. |
| `enter` | `(done: () => void) => void` | Callback-style entry for Fastify/Express hooks. |
| `get` | `() => RequestStore \| undefined` | The current request's store, if any. |
| `setSubject` | `(subject: Subject) => void` | Set the active subject. |
| `getSubject` | `() => Subject \| null` | The active subject. |
| `addExtra` | `(extra: Record<string, unknown>) => void` | Merge one-shot extras for the next tracked insert. |
| `consumeExtra` | `() => Record<string, unknown> \| null` | Return and clear the extras. |

::: warning
Under Bun, awaiting a promise that resolves inside `store.run()` does not propagate ALS context to the code after the `await`. Framework hooks must use the callback form, `store.enter(done)` — this is why both shipped integrations enter the store inside the hook's `done()` call stack.
:::

## Error classes

All guards and `engine.authorize()` throw subclasses of `RbacError`. Each carries a stable machine-readable `code`; `toBody()` returns the default response body `{ message, code }`. See [Errors](/reference/errors) for the full behavior reference.

```ts
abstract class RbacError extends Error {
  abstract readonly statusCode: number
  abstract readonly code: RbacErrorCode
  toBody(): { message: string; code: RbacErrorCode }
}

type RbacErrorCode =
  | 'RBAC_UNAUTHENTICATED'
  | 'RBAC_POLICY_DENIED'
  | 'RBAC_SCOPE_DENIED'
  | 'RBAC_RESOURCE_NOT_FOUND'
  | 'RBAC_MISCONFIGURED'
```

| Class | Status | Code | Constructor | Extra fields |
| --- | --- | --- | --- | --- |
| `UnauthenticatedError` | 401 | `RBAC_UNAUTHENTICATED` | `(message = 'Unauthorized')` | — |
| `PolicyDeniedError` | 403 | `RBAC_POLICY_DENIED` | `(policy, message = 'Forbidden')` | `policy` |
| `ScopeDeniedError` | 403 | `RBAC_SCOPE_DENIED` | `(policy, scope, message = 'Forbidden')` | `policy`, `scope` |
| `ResourceNotFoundError` | 404 | `RBAC_RESOURCE_NOT_FOUND` | `(message = 'Not found')` | — |
| `MisconfiguredError` | 500 | `RBAC_MISCONFIGURED` | `(message)` | — |

### UnknownPolicyError

```ts
class UnknownPolicyError extends Error
```

Thrown by adapters when `assignPolicy` targets a policy that was never synced. Message: `[rbac] Policy "<name>" not found — run \`rbac sync\` first.` Not an `RbacError` — it signals a setup problem, not a request outcome, so it never maps to an HTTP denial.

## Helper functions

### qualifyPolicyName()

```ts
function qualifyPolicyName(portal: string, policy: string): QualifiedPolicyName
```

Returns `` `${portal}.${policy}` ``, or `policy` unchanged when `portal` is `''`. Exactly one layer qualifies names — the engine; portal guards and portal assignment sugar take unqualified names and qualify them here, while `rbac.admin` takes already-qualified names.

### toSubjectRef()

```ts
function toSubjectRef(subject: Subject): SubjectRef
```

Normalizes a `Subject` into strict storage coordinates: `{ subjectId: subject.id, portal, contextId }` with missing `portal`/`context_id` becoming `''`.

### normalizeSentinel()

```ts
function normalizeSentinel(value: string | null | undefined): string
```

Returns `value ?? ''`. Portal and context columns are `NOT NULL DEFAULT ''` on every backend, so strict matching is plain equality and a null-context fallback is structurally impossible.

### defineConfig()

```ts
function defineConfig(config: RbacConfig): RbacConfig

interface RbacConfig {
  adapter: () => Promise<StorageAdapter> | StorageAdapter
  portals: PortalConfig[]
  typegen?: { output?: string } // default './rbac.d.ts'
}

interface PortalConfig {
  name?: string    // omit or '' for a portal-less setup
  policies: string // path to the module exporting `resources`
  groups?: string  // path to the module exporting `groups`
}
```

Typed identity for `rbac.config.ts` — gives the [CLI](/reference/cli) config full autocompletion. The `adapter` factory is lazy so commands that need no database (`rbac generate`) never open a connection. See [Configuration](/reference/configuration).

### syncPolicies()

```ts
function syncPolicies(
  adapter: StorageAdapter,
  resources: { policies: Policy[] }[],
  portal?: string,
  options?: { logger?: (msg: string) => void },
): Promise<void>
```

Sync policies-as-code into storage for one portal (`''` sentinel when omitted): upsert, delete orphans (filtered on the stored `portal` column), then back-fill missing transitive dependencies into every group.

**Throws** `Error` when a policy's `dependsOn` names a policy that is not defined in `resources`.

An empty policy list returns early on purpose — it never wipes a portal. Unlike `rbac.sync()`, this function does not call `adapter.ensureSchema?.()`.

### seedGroups()

```ts
function seedGroups(
  adapter: StorageAdapter,
  groups: GroupsDefinition,
  allPolicies?: { name: string }[],
  portal?: string,
): Promise<void>

type GroupsDefinition = Record<string, GroupDefinition>

interface GroupDefinition {
  label: string
  description?: string
  isSystem?: boolean
  policies: GroupPoliciesInput
}

type GroupPoliciesInput = 'all' | string[] | Record<string, string | null>
```

Upserts each group and replaces its policy entries exactly. `policies` accepts `'all'` (every policy in `allPolicies`, unrestricted), a `string[]` (those policies, unrestricted), or a record mapping policy name to scope (`null` = unrestricted). Names are unqualified — `seedGroups` qualifies them with the portal sentinel.

**Throws** `Error` when a group uses `policies: 'all'` and no `allPolicies` array was passed.

### createId()

```ts
function createId(): string
```

Re-export of `@paralleldrive/cuid2`'s id generator, used by the generated Drizzle schemas. Re-exported so CLI-generated schema files in user projects do not need a direct dependency on `@paralleldrive/cuid2` under strict pnpm layouts.

## Core types

### Subject, SubjectInput, SubjectRef

```ts
interface Subject {
  id: string
  portal?: string
  context_id?: string
  is_super?: boolean // bypasses all policy checks — reserve for break-glass accounts
  [key: string]: unknown
}

interface SubjectInput { // what a portal's getSubject returns; the portal adds `portal`
  id: string
  context_id?: string
  is_super?: boolean
  [key: string]: unknown
}

interface SubjectRef { // strict storage coordinates; '' sentinel means "none"
  subjectId: string
  portal: string
  contextId: string
}
```

### RbacTypes and the name unions

```ts
interface RbacTypes {} // empty by default; augment it from your project

type PortalName = /* RbacTypes['Portal'] or string */
type AnyPolicyName = /* RbacTypes['PolicyName'] or string */
type PortalPolicyName<P extends string> = /* RbacTypes['PortalPolicies'][P] or string */
type QualifiedPolicyName = string
```

Augment `RbacTypes` (the CLI's `rbac sync` / `rbac generate` writes an `rbac.d.ts` doing exactly this) to get typed portal names and per-portal policy autocompletion:

```ts
declare module '@kyrobit/rbac' {
  interface RbacTypes {
    Portal: 'admin' | 'branch'
    PolicyName: 'posts.read' | 'posts.write'
    PortalPolicies: { admin: 'posts.read' | 'posts.write'; branch: 'posts.read' }
  }
}
```

The interface is empty by default so augmentation adds members instead of re-declaring them — TypeScript rejects re-declaring a property with a narrower type. See [TypeScript](/guide/typescript).

### DecisionEvent, DecisionHook

```ts
interface DecisionEvent {
  subjectId: string
  portal: string
  contextId: string
  policy: QualifiedPolicyName
  decision: 'allow' | 'deny'
  reason: 'granted' | 'super' | 'no-policy' | 'scope-denied' | 'no-subject' | 'resource-not-found'
  scope: string | null
  cacheHit: boolean
  durationMs: number
}

type DecisionHook = (event: DecisionEvent) => void
```

Fired after every authorization decision, allow or deny. Errors thrown by the hook are swallowed — observability must never affect authorization.

### PolicyMap, ResourceRef, Awaitable

```ts
type PolicyMap = Map<string, string | null> // policy name → scope (null = unrestricted)
interface ResourceRef { type: string; id: string }
type Awaitable<T> = T | Promise<T>
```

### ResourceDefinition, ContextPolicies

```ts
interface ResourceDefinition {
  type: string
  policies: Policy[]
  table?: unknown // Drizzle table or Mongoose model — consumed by trackedDb / the plugin
  context?: Record<string, ContextPolicies> // portal name → policy name → scope names
}

type ContextPolicies = Record<string, string[]>
```

`table` is optional: storage-level features (ownership auto-tracking, query scoping) need it; guard-only usage does not.

## StorageAdapter

The contract every storage backend implements. The normative semantics are the twenty clauses S1–S20 in the source contract; an adapter conforms exactly when it passes [`runStorageAdapterContractSuite()`](/reference/testing#runstorageadaptercontractsuite). See [Writing a storage adapter](/guide/writing-a-storage-adapter).

```ts
interface StorageAdapter {
  readonly id: string
  readonly capabilities: AdapterCapabilities

  ensureSchema?(): Promise<void> // optional DDL/index hook, idempotent
  close?(): Promise<void>        // release connections; the CLI calls it after sync

  // Policy sync
  upsertPolicies(rows: PolicyDefinitionRow[]): Promise<void>
  listPolicies(): Promise<PolicyRecord[]>
  deletePolicies(ids: string[]): Promise<void> // cascades group entries + direct assignments

  // Groups
  upsertGroup(group: {
    name: string
    label: string
    description?: string
    isSystem?: boolean
    isActive?: boolean
  }): Promise<void>
  listGroups(): Promise<GroupRecord[]>
  getGroupPolicies(groupName: string): Promise<GroupPolicyEntry[]>
  setGroupPolicies(groupName: string, entries: GroupPolicyEntry[]): Promise<void>
  addGroupPolicies(groupName: string, entries: GroupPolicyEntry[]): Promise<void>

  // Assignments
  assignGroup(ref: SubjectRef, groupName: string): Promise<void>
  removeGroup(ref: SubjectRef, groupName: string): Promise<void>
  assignPolicy(ref: SubjectRef, policyName: string, scope?: string | null): Promise<void>
  removePolicy(ref: SubjectRef, policyName: string): Promise<void>

  // Enforcement hot path — group + direct grants, strict-matched on (portal, contextId)
  getSubjectPolicies(ref: SubjectRef): Promise<PolicyGrant[]>

  // Ownership — powers Scope.owned() on every backend
  recordOwnership(entries: OwnershipEntry[]): Promise<void>
  isOwner(ownerId: string, resource: ResourceRef): Promise<boolean>
  removeOwnership(resource: ResourceRef): Promise<void>
}
```

### Row types

```ts
interface PolicyDefinitionRow {
  name: string          // fully qualified, e.g. 'admin.posts.read'
  portal: string        // '' sentinel
  label: string
  scopeOptions: string[]
  dependsOn: string[]   // fully qualified
}

interface PolicyRecord {
  id: string            // opaque, non-empty, stable across calls
  name: string
  portal: string
  dependsOn: string[]
}

interface PolicyGrant {
  name: string
  scope: string | null  // null = unrestricted
}

interface GroupRecord {
  id: string
  name: string
  label: string
  isSystem: boolean
  isActive: boolean     // false = group grants nothing (kill-switch)
}

interface GroupPolicyEntry {
  policyName: string    // qualified name, not an id
  scope: string | null
}

interface OwnershipEntry {
  resourceType: string
  resourceId: string
  ownerId: string
  contextType: string   // '' sentinel — usually the portal the resource was created from
  contextId: string     // '' sentinel — the tenant context it was created in
}

interface AdapterCapabilities {
  autoOwnershipTracking: boolean // trackedDb / rbacPrismaExtension / rbacMongoosePlugin available
  queryScoping: boolean          // automatic query scoping available
}
```

## Cache types

Re-exported from the core barrel for adapter and hook authors; the implementations live at [`@kyrobit/rbac/cache`](/reference/cache).

```ts
interface PolicyCacheKey {
  id: string        // `rbac:v1:<enc(subjectId)>:<enc(portal)>:<enc(contextId)>`
  subjectId: string
  portal: string
  contextId: string
}

interface PolicyCache {
  get(key: PolicyCacheKey): Awaitable<PolicyMap | undefined>
  set(key: PolicyCacheKey, value: PolicyMap): Awaitable<void>
  invalidateSubject(subjectId: string): Awaitable<void>
  clear(): Awaitable<void>
}

type InvalidationEvent = { type: 'subject'; subjectId: string } | { type: 'all' }

interface InvalidationBus {
  publish(event: InvalidationEvent): Awaitable<void>
  subscribe(handler: (event: InvalidationEvent) => void): () => void
  close?(): Awaitable<void>
}

interface CacheEvent {
  type: 'hit' | 'miss' | 'set' | 'invalidate-subject' | 'clear'
  subjectId?: string
}

type CacheHook = (event: CacheEvent) => void
```
