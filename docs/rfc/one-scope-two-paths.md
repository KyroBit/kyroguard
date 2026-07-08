# RFC: One Scope, Two Paths — Unified Guard Checks and List Filtering

**Status:** Proposal · **Affects:** `core/scope.ts`, `core/engine.ts`, `core/policy.ts`, `storage/contract.ts`, all three adapters, both framework integrations, `storage/drizzle/tracked-db.ts` (deprecation), `storage/mongoose/plugin.ts` (deprecation)

## 0. The problem in one paragraph

`Scope.check(subject, resource, ctx)` answers "may this user touch **this** row." LIST endpoints need the other direction — "which rows may this user see" — and today that lives in a **second, unrelated mechanism**: the tracked-db select proxy plus a static `resource.domains` + `queryScopes` config (Drizzle), and a pre-`find` hook with its own `queryScopes`/`domains` copy (Mongoose). That path is not grant-aware (it keys off the subject's *domain*, not the subject's *grants*), it duplicates the scope's logic in a second place, it works by proxy magic, and Prisma has nothing. This RFC makes the grant's scope the single source of truth for both paths and deletes the second mechanism.

---

## 1. How the industry does it

| System | List API | Return shape | Resource genericity | Who translates to ORM/SQL |
|---|---|---|---|---|
| **Cerbos** | `planResources({principal, resource: {kind}, action})` — same policy as `checkResources`, partially evaluated with the resource unknown | Trichotomy: `KIND_ALWAYS_ALLOWED` / `KIND_ALWAYS_DENIED` (return `[]`, skip the DB) / `KIND_CONDITIONAL` + operator AST | Derived roles (`owner`) defined once, imported per resource; relies on an `attr.owner` naming convention | Library ships per-ORM adapters (Prisma, Drizzle, Mongoose…); developer supplies an attr→column **mapper** at the call site |
| **Oso (legacy lib)** | `authorized_query(actor, action, cls)` — same Polar rule, evaluated with resource unbound | Live ORM query you keep chaining; deny = `WHERE false` as the OR-fold seed, allow = `WHERE true` | Polar rules over abstract types; per-class field/relation **registration map** (`register_class(cls, fields=…)`) | Library emits a tiny DNF IR; per-ORM adapters (~60 lines each) consume it |
| **CASL** | `accessibleBy(ability, action).ofType('Post')` — same rule objects as `ability.can()` | Native fragment (Prisma `WhereInput` / Mongo filter); deny = `{OR: []}` / `{$expr:{$eq:[0,1]}}` (v1 threw — most-complained-about behavior, reverted) | Not generic: conditions name concrete columns per subject type; genericity by naming convention only | Conditions ARE query-shaped data; per-ORM packages wrap them; generic `rulesToCondition` + `{and,or,empty}` hooks for the rest |
| **Casbin** | None — `BatchEnforce` post-filter loop, `GetImplicitPermissions` → `IN`, or SQL strings inside policy rows | `[]bool` / ID tuples / SQL strings; no trichotomy (`ERR_EMPTY_CONDITION` exists only because empty conditions fail **open** in ORMs) | Not generic; column names baked into policy text | The developer, entirely — the acknowledged "two sources of truth" failure this RFC avoids |
| **Postgres RLS** | None — one `USING` predicate rewritten into every query; `SET LOCAL` carries the subject | Rows. Default-deny = injected `false`; `USING(true)` = allow; multiple permissive policies **OR** together | None (per-table policies); genericity via column convention or a central mapping table joined by EXISTS — exactly `kyroguard_resource_owners` | The Postgres planner; predicate *is* SQL. Non-row predicates constant-fold once per query |
| **Pundit** | `policy_scope(Post)` → `Scope#resolve(user, scope)` in the same policy class as `update?` | Chainable Relation: `scope.all` / `scope.none` (`WHERE 1=0`) / `scope.where(…)`; fail-loud if undefined | None — every policy re-implements `where(user_id:)`; check/scope drift is *the* classic Pundit bug | The developer writes native queries; zero library machinery, zero guarantees |
| **SpiceDB / OpenFGA** | `LookupResources` / `ListObjects` → ID stream → `WHERE id IN (…)` | ID list only; no "no filter" arm (admin must enumerate everything); OpenFGA caps at 1,000 + silently truncates on deadline | Fully generic — ownership lives in the engine's own tuple store `(type, id, relation, subject)` = `kyroguard_resource_owners` as a service | Nobody; developer writes the `IN`. Composability with search/sort/pagination is the #1 complaint |

**Convergent findings across all five reports:**

1. **One definition, two evaluation modes.** Check = evaluate with the resource bound; list = evaluate with the resource unknown. Never a second config surface (Casbin's four workarounds are the cautionary tale — and our `queryScopes`/`domains` config is exactly that failure).
2. **The return is a strict trichotomy**: allow-all / deny-all / conditional-fragment. Deny short-circuits *before* the DB. Never ambiguous with "no filter", never fail-open, never thrown from the list path (CASL #794).
3. **Row-less conditions never become SQL.** They are evaluated once against `(subject, ctx)` at filter-build time and fold the plan to allow/deny — Cerbos folds `now()`, Oso pre-evaluates actor-side conditions, RLS constant-folds STABLE predicates, CASL bakes them in at build. We already have this mechanism: `check(subject, null, ctx)`.
4. **Grants OR together** (RLS permissive policies; Cerbos ORs matching rules; CASL ORs can-branches). An unscoped grant short-circuits to allow-all.
5. **Return a composable fragment, never a wrapped query and never an ID list as the primary mechanism.** Fragments keep pagination, COUNT, ORDER BY, and the app's own WHERE native.
6. **Genericity = central fact store for ownership + a small per-resource registration for genuine field mapping.** Our `kyroguard_resource_owners` is structurally Zanzibar's tuple store living *in the same database* — the EXISTS join is what SpiceDB needs a whole replication product (Materialize) to fake. This is the library's strongest card.

**On the DSL question:** the research supports the author's instinct. A conditions-AST (Cerbos/Oso/CASL-style) buys ORM-portability of *custom* scopes at the price of a whole condition language, per-ORM visitors, operator tables, normalization rules ("Cerbos needed several releases to make plan simplification predictable"), and stringly-typed mapper drift. Pundit's posture — the author writes the native fragment, the library owns resolution, composition, and the trichotomy — is the simplicity bar this library sells. We take Pundit's ceremony, Cerbos's trichotomy and grant-OR semantics, and beat both on ownership via the central store. The AST remains a possible v2 *under the same public API* (nothing below precludes it).

---

## 2. The design

### 2.1 `Scope` grows an optional filter half

One scope object owns both halves (Pundit's single-class pattern). `check` is unchanged. `filter` is new and optional:

```ts
// src/core/scope.ts

export interface ScopeCheckContext {
  db: unknown
  adapter: StorageAdapter
}

/** Passed to the filter half. Everything a filter needs to stay resource-generic. */
export interface ScopeFilterContext extends ScopeCheckContext {
  /** The registered resource being listed — type, table/model, id column, field map. */
  resource: ResourceDefinition
}

/**
 * The list-path decision for ONE grant's scope:
 *  - `true`   → this scope imposes no row restriction (condition passed)
 *  - `false`  → this grant contributes nothing (condition failed / can't filter: fail closed)
 *  - `{where}`→ a NATIVE fragment for the active backend (Drizzle SQL expression,
 *               Prisma WhereInput, Mongoose FilterQuery), whose only free variables
 *               are resource columns — subject/ctx values are baked in as literals.
 */
export type ScopeFilterResult = boolean | { where: unknown }

export type ScopeFilterFn = (
  subject: Subject,
  ctx: ScopeFilterContext,
) => Awaitable<ScopeFilterResult>

export class Scope {
  constructor(
    readonly name: string,
    readonly label: string,
    readonly check: ScopeCheckFn,
    /** List-path compilation. Omit for condition-only scopes — check(subject, null, ctx) is used. */
    readonly filter?: ScopeFilterFn,
  ) {}

  static owned(name = 'owned', label = 'Owned by the user'): Scope {
    return new Scope(
      name,
      label,
      (subject, resource, ctx) =>
        resource ? ctx.adapter.isOwner(subject.id, resource) : false,
      (subject, ctx) => {
        const support = ctx.adapter.listFilters
        if (!support) return false // adapter can't filter lists: fail closed
        return support.owned(subject.id, ctx.resource, ctx.db)
      },
    )
  }
}
```

**The fallback rule (this is the whole answer to the time/attribute question):** a scope with **no** `filter` is evaluated on the list path by calling its existing `check(subject, null, ctx)` exactly once per request. `true` → that grant contributes allow-all; `false` → that grant contributes nothing. Condition scopes (`grading-window`, "not on probation", subject attributes) therefore work on the list path **with zero new code** — the same partial-evaluation move as Cerbos folding `now()` and RLS constant-folding, expressed through the null-resource semantics the library already documents. Row scopes without a `filter` fail closed under the same rule (their check already returns `false` on `null`) — and the engine logs a one-time warning naming the scope (§2.5) so this is never a silent mystery.

### 2.2 The return trichotomy

```ts
// src/core/types.ts

export type ListFilter<TWhere = unknown> =
  | { kind: 'all' }                                    // query with no kyroguard restriction
  | { kind: 'none'; reason: 'scope-denied' | 'no-filter' }  // return [] — do not query
  | { kind: 'where'; where: TWhere; scopes: string[] } // AND this fragment into your query
```

- `all` — an unscoped grant (or a condition scope that passed with no row restriction). Costs nothing; never enumerate IDs for admins (the SpiceDB wart).
- `none` — grants exist but every branch folded false. `reason: 'scope-denied'` = a condition scope said no (the grading window after it closes); `'no-filter'` = the only applicable scopes had no query form. Documented pattern: short-circuit and return `[]` **without a DB round-trip** (Cerbos adapters' behavior). `filterFor` never *throws* for this case — CASL v1 threw from `accessibleBy` and it was the package's most-complained-about behavior; an empty list is the natural REST answer, and apps that want a 403 can branch on `kind`.
- `where` — a composable native fragment. `scopes` names the contributing scope(s) — the `filterDebug` analog, for "why does the teacher see zero grades."

No-subject and no-policy are **not** trichotomy cases — they throw the same typed `UnauthenticatedError` / `PolicyDeniedError` the guard throws (§2.4), so "may not list this collection at all" stays a 401/403, distinct from "may list it, sees nothing right now."

### 2.3 Grant model change: `PolicyMap` keeps *all* scopes

Today `mergeGrants` collapses multiple grants of one policy to a single scope (null wins, otherwise the **first named scope** — an arbitrary choice). Every researched system ORs permissive grants. This must change for both paths, or the guard and the list will disagree:

```ts
// src/core/types.ts
/** policy name → null (unrestricted) | deduped, sorted scope names (OR semantics). */
export type PolicyMap = Map<string, string[] | null>
```

`mergeGrants`: `null` from any grant still wins (→ `null`); otherwise the value is the deduped, sorted set of scope names. **Guard path change:** `authorize()` now passes if **any** of the policy's scopes passes (unknown scope names still contribute deny, never bypass). This is a behavior change only for subjects holding one policy through multiple *differently-scoped* grants — where the current first-scope behavior is a latent bug, not a feature. The cache value shape changes: bump the `policyCacheKey` version prefix so stale entries can't be misread.

### 2.4 The engine and domain API

```ts
// src/core/engine.ts

export interface EngineOptions {
  // …existing…
  /** Resource registry — resourceType → definition. Built by createKyroguard from options.resources. */
  resources: Map<string, ResourceDefinition>
}

export class KyroguardEngine {
  /**
   * List-path decision procedure. Throws UnauthenticatedError / PolicyDeniedError
   * exactly like authorize(); resolves with the trichotomy otherwise.
   */
  async filterFor(
    subject: Subject | null | undefined,
    policy: QualifiedPolicyName,
    resourceType: string,
  ): Promise<ListFilter>
}
```

Resolution algorithm (the whole thing — this is deliberately small):

```
filterFor(subject, policy, resourceType):
  1. no subject.id                    → throw UnauthenticatedError
  2. superBypass && subject.is_super  → { kind: 'all' }
  3. resource = resources.get(resourceType)
     unknown type                     → throw MisconfiguredError (loud, at dev time)
  4. map = getPolicyMap(ref)          // same cache as authorize()
     !map.has(policy)                 → throw PolicyDeniedError
  5. scopes = map.get(policy)
     scopes === null                  → { kind: 'all' }          // unscoped grant = USING(true)
  6. for each scope name (OR branches, RLS-permissive style):
       unknown name        → contributes nothing (warn once)     // parity with authorize's deny-on-unknown
       scope.filter        → r = await filter(subject, {db, adapter, resource})
       no scope.filter     → r = await check(subject, null, {db, adapter})   // condition fold
       r === true          → return { kind: 'all' }              // short-circuit: true OR x = true
       r === false         → skip                                 // false OR x = x
       r = { where }       → collect
  7. zero collected        → { kind: 'none', reason }             // deny is the fold seed
     one collected         → { kind: 'where', where, scopes }
     many                  → { kind: 'where', where: adapter.listFilters.or(collected), scopes }
```

Every resolution fires the decision hook (`reason: 'granted' | 'scope-denied'`, new `mode: 'list'` field on `DecisionEvent`) so list decisions are auditable like guard decisions.

**Framework contract** — explicit call in the handler, Pundit's `policy_scope` shape, no proxies:

```ts
// src/frameworks/contract.ts
export interface DomainInstance<TReq, TGuard, P extends string = string> {
  // …existing…
  /**
   * List-path counterpart of requirePolicy. Resolves the subject (memoized per
   * request/domain like requirePolicy), throws the same typed KyroguardErrors,
   * returns the trichotomy. `resource` is the registered resource type.
   */
  filterFor(
    req: TReq,
    policy: DomainPolicyName<P>,
    options: { resource: string },
  ): Promise<ListFilter>
}
```

### 2.5 Per-ORM filter authorship — who writes what

Three tiers, matching what each party actually knows:

**Tier 1 — the library (built-ins).** `Scope.owned()` compiles through a new optional adapter capability. The adapter is the only party that knows both the dialect and the ownership store, so it owns the translation:

```ts
// src/storage/contract.ts
export interface ListFilterSupport {
  /** Native fragment matching rows of `resource` owned by ownerId. May hit the DB (id-list backends). */
  owned(ownerId: string, resource: ResourceDefinition, db: unknown): Awaitable<unknown>
  /** OR-combine collected fragments: drizzle or(...), Prisma { OR: [...] }, Mongo { $or: [...] }. */
  or(wheres: unknown[]): unknown
  /** Canonical impossible predicate, for the toWhere() helpers: sql`1 = 0` / {$expr:{$eq:[0,1]}} . */
  none(): unknown
}

export interface StorageAdapter {
  // …existing…
  listFilters?: ListFilterSupport
}

export interface AdapterCapabilities {
  autoOwnershipTracking: boolean
  /** @deprecated superseded by listFiltering */
  queryScoping: boolean
  listFiltering: boolean
}
```

Per backend, `owned()` is:

- **Drizzle (pg/mysql/sqlite)** — the star path, a synchronous correlated EXISTS, resource-generic with zero per-resource mapping beyond the table registration:

  ```sql
  EXISTS (SELECT 1 FROM kyroguard_resource_owners ro
          WHERE ro.resource_type = :type
            AND ro.resource_id   = CAST(<idColumn> AS text)
            AND ro.owner_id      = :ownerId)
  ```

  Emitted with the adapter's own dialect tables; composes into any host query without perturbing row multiplicity, joins, or pagination. **Schema addition:** a composite index led by `(resource_type, owner_id)` (today only `(resource_type, resource_id)` exists) so the EXISTS is an index probe — the RLS research is unambiguous that this is the difference between a filter and theater.

- **Prisma** — Prisma's `WhereInput` cannot express an EXISTS against an unrelated table, and the ownership row is polymorphic (`resource_type` + `resource_id`), which Prisma relations can't model. So `owned()` queries the ownership model for `(resourceType, ownerId)` and returns `{ [idField]: { in: ids } }` — the ID-list fallback, honestly documented with its ~10k-per-(owner,type) ceiling (Oso Cloud's own documented limit for exactly this shape). This finally gives Prisma list filtering at all (`queryScoping: false` today).

- **Mongoose** — same ID-list shape against the ownership collection: `{ _id: { $in: ids } }` (cast to ObjectId when the model's `_id` is one). Same ceiling note.

**Tier 2 — the scope author (custom row scopes).** Writes the native fragment for the ORM the app uses — which is, in practice, exactly one function, because an app runs one ORM. This is the Pundit trade: no condition DSL to learn, full ORM power (joins, subqueries, whatever), and the parity obligation is made testable (§2.7) instead of pretending a DSL removes it.

**Tier 3 — resource-generic custom scopes via the field map.** Where a scope must stay generic across resources but references a resource column (`unpublished` → `grades.published` vs `reports.published`), the mapping lives in the **resource registration**, never in the scope (the unanimous lesson: Cerbos mappers, Oso `register_class`, versus CASL's convention-only weakness):

```ts
// src/core/policy.ts
export interface ResourceDefinition {
  type: string
  policies: Policy[]
  /** Drizzle table or Mongoose model (existing). */
  table?: unknown
  /** PK column for the EXISTS correlation. Drizzle: defaults to table.id. */
  idColumn?: unknown
  /** Prisma targeting: ownership id-list needs the model's id field name. */
  prisma?: { model: string; idField?: string }   // idField defaults to 'id'
  /** Abstract field name → native column / path / field name, read by generic scope filters. */
  fields?: Record<string, unknown>
  /** @deprecated Query-scoping config — replaced by filterFor. Removed next major. */
  domains?: Record<string, PolicyScopeMap>
}
```

An unmapped field is a **fail-closed `false`** plus a one-time named warning — never a silent allow-all (the Casbin `ERR_EMPTY_CONDITION` lesson, done right).

**Deny/allow composition helpers** — small, per backend, for callers who want one expression instead of the switch:

```ts
// @kyrobit/kyroguard/drizzle
export function drizzleWhere(f: ListFilter): SQL | undefined
// all → undefined · none → sql`1 = 0` · where → f.where as SQL

// @kyrobit/kyroguard/mongoose
export function mongoWhere(f: ListFilter): Record<string, unknown>
// all → {} · none → { $expr: { $eq: [0, 1] } } (CASL's EMPTY_RESULT_QUERY) · where → f.where
```

For Prisma the documented pattern is the explicit switch (short-circuit `none` to `[]`): Prisma has no portable impossible predicate — empty `OR` handling has a bug history (prisma#17367) — so we don't paper over it. **Documented footgun, verbatim in spirit from the CASL README:** never spread the fragment into another where object (later keys silently widen access); compose only via `and(...)` / `AND` / `$and`.

### 2.6 The three canonical scopes, end to end

```ts
// owned — library-shipped, resource-generic via the ownership store. Nothing to write.

// grading-window — condition scope: NO filter half, ever.
export const gradingWindow = new Scope('grading-window', 'Grading window', () => {
  const now = new Date()
  return now >= term.gradingOpens && now <= term.gradingCloses
})
// List path: engine calls check(subject, null, ctx) once → folds to all/none. Zero new code.

// unpublished — generic row scope, per-resource mapping via fields (Drizzle app shown).
import { eq } from 'drizzle-orm'
import type { AnyColumn } from 'drizzle-orm'

export const unpublished = new Scope(
  'unpublished',
  'Not yet published',
  async (user, resource, ctx) => {
    if (!resource) return false
    const [grade] = await db.select().from(grades).where(eq(grades.id, resource.id))
    return grade ? !grade.published : false
  },
  (user, ctx) => {
    const published = ctx.resource.fields?.published as AnyColumn | undefined
    if (!published) return false                    // unmapped resource: fail closed
    return { where: eq(published, false) }
  },
)

// registration — the ONLY per-resource knowledge:
const resources: ResourceDefinition[] = [
  { type: 'grade',  table: grades,  policies: [...], fields: { published: grades.published } },
  { type: 'report', table: reports, policies: [...], fields: { published: reports.published } },
]
```

Composed scopes — one scope calling the others, the combining pattern from [Scopes](/guide/scopes) — decompose one tier per half:

```ts
export const ownEditable = new Scope('own-editable', 'Own, unpublished, in window',
  async (user, resource, ctx) => { /* each rule's check, combined — see docs/guide/scopes.md */ },
  async (user, ctx) => {
    if (gradingWindow.check(user, null, ctx) !== true) return false   // boolean gate first
    const owned = await Scope.owned().filter!(user, ctx)              // row fragments second
    const unpub = await unpublished.filter!(user, ctx)
    if (owned === false || unpub === false) return false
    if (owned === true) return unpub
    if (unpub === true) return owned
    return { where: and(owned.where as SQL, unpub.where as SQL) }
  })
```

(If composition proves common, a `Scope.all(...scopes)` combinator that derives both halves is a natural follow-up — explicitly not in v1.)

### 2.7 Parity, structurally and by test

The invariant this feature exists to guarantee: **for every row, `check(subject, {type, id}, ctx)` ≡ row ∈ filtered query.** Two enforcements:

1. **Structural:** both paths resolve grants through the same `getPolicyMap`, the same scope registry, the same OR/fold rules. Condition scopes are parity-safe by construction (one function). Only Tier-2/3 custom row filters can drift.
2. **Test helper** in `@kyrobit/kyroguard/testing`:

```ts
export async function assertScopeParity(options: {
  guard: Kyroguard
  subject: Subject
  policy: QualifiedPolicyName
  resource: string
  /** All seeded rows as { id } plus whatever the query returns. */
  rows: Array<{ id: string }>
  /** Runs the caller's list query with the given ListFilter applied. */
  query: (filter: ListFilter) => Promise<Array<{ id: string }>>
}): Promise<void>
// Computes filterFor, runs query, and asserts per row:
//   authorize(subject, policy, { resource: () => ({ type, id: row.id }) }) resolves
//   ⇔ row.id ∈ query results.
```

One test per (scope, resource) pair recovers RLS's by-construction guarantee. Documented as strongly recommended for every custom `filter`.

Also documented (free, once `filterFor` exists): **fetch single records through the filter** — `db.select().from(grades).where(and(eq(grades.id, id), drizzleWhere(f)))` — Pundit's `policy_scope(Post).find(id)` pattern, giving out-of-scope and nonexistent rows identical 404s on read paths.

---

## 3. Worked examples (docs voice)

### The teacher's list

The update guard from [Scopes](/guide/scopes) already knows a teacher only touches the grades they entered. The list endpoint asks the same grant the other question — *which rows?* — with `filterFor`:

::: code-group

```ts [Fastify]
app.get('/grades', async req => {
  const f = await teachers.filterFor(req, 'grades.view', { resource: 'grade' })
  if (f.kind === 'none') return []                    // nothing qualifies — skip the query
  return db.select().from(grades)
    .where(f.kind === 'all' ? undefined : f.where as SQL)
    .orderBy(desc(grades.createdAt))
    .limit(20)
})
```

```ts [Express]
app.get('/grades', async (req, res) => {
  const f = await teachers.filterFor(req, 'grades.view', { resource: 'grade' })
  if (f.kind === 'none') return res.json([])
  const rows = await db.select().from(grades)
    .where(f.kind === 'all' ? undefined : f.where as SQL)
    .limit(20)
  res.json(rows)
})
```

:::

The teacher's grant is `'grades.view': 'owned'`, so `f` comes back as `{ kind: 'where' }` carrying one EXISTS against the ownership store — the teacher's page holds only the grades they entered, and `LIMIT 20` means twenty of *theirs*, not twenty minus everyone else's. No `grades.view` grant at all still throws — a 403, same as any guard. Your own conditions AND in alongside: `and(eq(grades.subject, 'maths'), f.where)`. Never spread `f.where` into another object — spreading can overwrite keys and quietly widen access.

### The admin's list

Same route, no new code. The admin's grant is `'grades.view': 'all'` — no condition — so `filterFor` returns `{ kind: 'all' }` and the query runs unfiltered. No filter built, no IDs enumerated, nothing to pay. One grant through a group with a scope **and** another without? The unrestricted one wins, exactly as it does at the guard.

### Outside the grading window

The deadline rule from [Scopes](/guide/scopes) — `'grades.view': 'grading-window'` — never looks at a row, so it never becomes SQL. At list time the engine runs the same check it runs at the guard, once, with no resource: while the window is open it folds to *no restriction*; after it closes it folds to `{ kind: 'none', reason: 'scope-denied' }` and the endpoint returns an empty list without touching the database. Prefer a 403 after the window closes? Branch on it:

```ts
if (f.kind === 'none' && f.reason === 'scope-denied') {
  return reply.code(403).send({ code: 'ACCESS_DENIED' })
}
```

The scope needs nothing new for any of this — a condition scope's `check` **is** its list behavior.

---

## 4. Migration and deprecation

**Phase 1 — next minor (additive).**
- Ship: `Scope#filter`, `ListFilter`, `engine.filterFor`, `domain.filterFor`, `StorageAdapter.listFilters` on all three adapters, `capabilities.listFiltering`, `ResourceDefinition.idColumn/prisma/fields`, `drizzleWhere`/`mongoWhere`, `assertScopeParity`, the `(resource_type, owner_id)` index in `ensureSchema`.
- `PolicyMap` becomes `Map<string, string[] | null>`; `authorize` ORs across scopes; cache key version bumped (external caches repopulate; the semantic change only affects subjects holding one policy under multiple different scopes — release-noted prominently).
- Deprecate with one-time runtime warnings: `TrackedDbOptions.queryScopes`, `ResourceDefinition.domains`, `KyroguardMongoosePluginOptions.queryScopes`/`domains`, `capabilities.queryScoping`. Old path keeps working unchanged.

**Phase 2 — docs.** Rewrite the query-scoping guide around `filterFor`. Migration table:

| Today | After |
|---|---|
| `queryScopes: { owned: (subject) => eq(grades.teacherId, subject.id) }` | Delete — `Scope.owned()` ships its filter via the adapter |
| `resource.domains: { teachers: { 'grades.view': ['owned'] } }` | Delete — the grant already says it; `filterFor` reads the grant |
| Implicit scoping on every `db.select().from(grades)` | Explicit `const f = await teachers.filterFor(req, 'grades.view', { resource: 'grade' })` in the list handler |
| Custom `queryScopes['unpublished']` builder | The same builder body, moved into `new Scope(..., filter)` next to its `check` |
| Mongoose pre-`find` auto-filter | `Model.find(mongoWhere(f))` in the handler |

The move from implicit to explicit is deliberate (the stated requirement): the proxy silently applied the *wrong* thing — domain-keyed, not grant-keyed — and silently applied *nothing* for unregistered tables. Explicit is what Pundit, CASL, and Cerbos all converged on.

**Phase 3 — next major (removal).**
- `tracked-db.ts`: remove `wrapSelectBuilder` / `wrapScopedFrom` / `buildScopeSql` and the `queryScopes` option. **Insert tracking, ownership recording, and `db.untracked` stay** — `trackedDb` remains the ownership-tracking layer only.
- `mongoose/plugin.ts`: remove the pre-`find` hook and `queryScopes`/`domains` options; ownership hooks stay.
- Remove `ResourceDefinition.domains`, `PolicyScopeMap` from the public surface, and `capabilities.queryScoping`.

---

## 5. Out of scope (v1)

- **A conditions DSL / portable filter AST.** The public API (trichotomy + native fragments) doesn't preclude adding one later as an *authoring convenience* that compiles into the same `ScopeFilterResult`.
- **Nested/included relation filtering** (`include:` children come back unfiltered — CASL's acknowledged gap; caller's responsibility, documented).
- **Field/column masking** (separate mechanism with separate failure modes; CASL keeps it out of `accessibleBy` too).
- **Write-path validation** (RLS `WITH CHECK` analog — validating that an inserted/updated row would satisfy the scope).
- **Restrictive (AND-composed) scopes** across grants; grants OR, full stop.
- **Multi-policy plans** (`filterFor(subject, ['grades.view','grades.update'], …)` sharing one grant fetch — cheap later since the map is cached).
- **A fetch-then-check post-filter helper.** `filterFor` + a manual `authorize` loop is expressible today; blessing it invites the broken-pagination trap all five reports warn about.
- **Cross-database filtering** (data table and `kyroguard_resource_owners` in different databases) beyond what the Prisma/Mongoose ID-list already tolerates.
- **List-filter caching.** Filters are per-(subject, policy, resource, ctx) by design; the grant map is already cached, which is the only expensive part (the unanimous Oso/CASL guidance).

## 6. Honest costs

- **Custom row-scope filters are hand-written per ORM.** No AST means a `filter` written with Drizzle operators does nothing for a Mongoose app. In practice an app has one ORM so it's one function; a *shipped/shared* scope that must span backends has to branch on `ctx.adapter.id`. This is the Pundit trade, taken knowingly.
- **check/filter parity for custom scopes is by convention, not construction.** Two hand-written halves can drift — the classic Pundit bug class. Mitigation is `assertScopeParity` plus the structural sharing of grant resolution; it is a mitigation, not a proof.
- **Prisma and Mongoose `owned()` is an ID-list**, with an extra query per list request and a real ceiling (~10k owned rows per (owner, type) before `IN`-lists hurt — the documented Oso Cloud limit for the same shape). Only Drizzle gets the single-round-trip EXISTS. If it bites, the escape hatches are a denormalized `ownerId` column with a two-line custom scope, or (Prisma) a hand-declared relation.
- **Explicitness costs a call per list endpoint**, and forgetting it leaks — the exact bug the old proxy hid (incorrectly). Pundit ships `verify_policy_scoped` for this; a dev-mode "guarded list route never consumed its filter" warning is a candidate follow-up, not in v1.
- **A filterless row scope yields an empty list, not an error.** The condition-fold fallback is what makes `grading-window` free, and its flip side is that a row scope missing its `filter` folds to `none` silently-but-warned. The alternative (throwing) would break every condition scope or demand explicit classification — more ceremony than it buys.
- **The guard-path OR-of-scopes change** is real behavior change for multi-scoped grants, and the cache format bump invalidates warm external caches on deploy.
- **No portable deny fragment for Prisma** — the switch/short-circuit is mandatory there; `drizzleWhere`/`mongoWhere` conveniences have no Prisma sibling.
- **One more index** on `kyroguard_resource_owners` (`resource_type, owner_id`), and the EXISTS casts `resource_id` (text) against native PKs — fine for text/uuid PKs, a per-dialect cast for integer PKs that the adapters own and must snapshot-test.