# Upgrading to 2.0

Version 2 makes scopes the single mechanism for "which rows", and removes kyroguard's own store of facts about your data.

In 1.x a scope had two halves — a `check` for one row and a `filter` for lists — and three built-ins (`Scope.owned()`, `Scope.granted()`, `Scope.inTenant()`) backed by a `kyroguard_resource_owners` table the library wrote to on every insert. That design had a permanent hazard: the check and the filter could disagree, and the ownership table could drift from your data on every write path the ORM hooks did not see.

In 2.0 a scope is **one function you write against your own tables**, and its condition goes into every query for the resource — reads, updates and deletes alike.

```ts
// 1.x
new Policy('grades.update', { scopeOptions: [Scope.owned()] })

// 2.0 — your column, your rule
const entered = new Scope('entered', 'Entered by the teacher', subject => ({
  where: eq(grades.enteredBy, subject.id),
}))
new Policy('grades.update', { scopeOptions: [entered] })
```

## What this fixes

- A check and a filter can no longer disagree — there is one answer.
- Ownership cannot drift. It is a column in your schema, written by the handler that creates the row, in the same transaction.
- The `kyroguard_resource_owners` table no longer grows as `tenants × tables`, and a scope on an indexed column is an index scan instead of a semi-join against a central table.

## Breaking: `Scope` takes one function

```ts
// 1.x
new Scope(name, label, check, filter?)

// 2.0
new Scope(name, label, filter)
```

The function receives `(subject, ctx)` where `ctx` is `{ db, adapter, resource }`, and returns `true` (no restriction), `false` (no rows), or `{ where }` — a native fragment for your ORM.

**To migrate:** keep your old `filter` half and delete the `check`. A scope that only had a `check` becomes a `filter` returning `true`/`false` (a condition scope) or `{ where }` (a row rule expressed as a condition).

## Breaking: the built-in scopes are gone

`Scope.owned()`, `Scope.granted()` and `Scope.inTenant()` no longer exist, along with the table behind them.

**To migrate:** add the column the rule was really about, and write the scope against it.

| 1.x | 2.0 |
| --- | --- |
| `Scope.owned()` | an owner column on your table + `{ where: eq(t.ownerId, subject.id) }` |
| `Scope.inTenant()` | a tenant column + `{ where: eq(t.tenantId, subject.tenant_id) }` |
| `Scope.granted()` | your own share/join table + an `EXISTS` against it |

[Ownership](/guide/ownership) shows all three patterns in full.

The grant rows themselves need no change: a grant stores a scope *name*, so `'owned'` keeps working if you name your new scope `'owned'`.

### Migrating existing ownership rows

Before dropping `kyroguard_resource_owners`, copy what it knows into your own columns. One statement per resource type:

```sql
ALTER TABLE grades ADD COLUMN entered_by text;

UPDATE grades SET entered_by = ro.owner_id
FROM kyroguard_resource_owners ro
WHERE ro.resource_type = 'grade'
  AND ro.resource_id = grades.id::text
  AND ro.relation = 'owner';

-- check before you trust it
SELECT count(*) FROM grades WHERE entered_by IS NULL;
```

Then drop the table. Regenerate your schema file first (`kyroguard init` writes five tables now, not six) and read the generated migration before applying it.

## Breaking: no ownership or access API

`guard.ownership.record()`, `.isOwner()`, `.remove()`, `.addExtra()` and the whole `guard.access` API are gone, as are the adapter methods behind them (`recordOwnership`, `isOwner`, `removeOwnership`, `getAccess`, `removeAccess`) and `capabilities.autoOwnershipTracking`. Fastify's `app.kyroguard.addExtra()` goes with them — it existed only to stamp the ownership row.

**To migrate:** a `guard.ownership.record(user.id, …)` call becomes a column in the insert you were already making:

```ts
// 1.x
const [grade] = await db.insert(grades).values({ student, score }).returning()
await guard.ownership.record(user.id, { type: 'grade', id: grade.id })

// 2.0
await db.insert(grades).values({ student, score, enteredBy: user.id })
```

`guard.access.grant()` / `.revoke()` become inserts and deletes on your own share table.

## Breaking: inserts are no longer intercepted

`scopedDb`, `scopeExtension` and `scopePlugin` no longer touch inserts. They filter: selects, joins, `db.query`, updates and deletes.

This removes the `strictTracking` option and the requirement to chain `.returning()` on an insert.

**To migrate:** set your owner and tenant columns explicitly in the handler. This is now the only place they are written, which is the point — nothing writes them behind your back, and nothing can be missed by a hook that did not fire.

## Breaking: a scope never denies a request

A scoped grant is still a grant, so the guard allows the request. The scope narrows the query instead, and a row it excludes is simply not found.

Removed as a consequence:

- `requirePolicy(policy, { resource })` — the second argument is gone; guards take only a policy name. So is the implicit `params.id` resolver.
- `ScopeDeniedError` and `ResourceNotFoundError`, and the `reason` field on `ACCESS_DENIED` bodies (`AccessDeniedReason` with it). A guard now produces 401 or 403, nothing else.
- `assertScopeParity` — there are no longer two paths to keep in parity.

**To migrate:** delete the `resource` resolvers from your routes. Make sure each handler answers 404 when its row is missing — that branch now covers "not yours" as well as "not there". If a client relied on `reason: 'scope'`, it now sees a 404 from your handler instead of a 403.

```ts
// 1.x
app.patch('/grades/:id', {
  preHandler: teachers.requirePolicy('grades.update', {
    resource: req => ({ type: 'grade', id: req.params.id }),
  }),
}, updateGrade)

// 2.0
app.patch('/grades/:id', { preHandler: teachers.requirePolicy('grades.update') }, updateGrade)
```

## Breaking: the integrations are renamed

They tracked nothing any more — they scope queries — so the names say that:

| 1.x | 2.0 |
| --- | --- |
| `trackedDb(db, opts)` | `scopedDb(db, opts)` |
| `trackingExtension(opts)` | `scopeExtension(opts)` |
| `trackingPlugin` | `scopePlugin` |
| `db.untracked` | `db.unscoped` |
| `TrackedDbOptions` | `ScopedDbOptions` |
| `TrackingExtensionOptions` / `TrackingExtension` | `ScopeExtensionOptions` / `ScopeExtension` |
| `TrackingResourceRegistration` | `ScopeResourceRegistration` |
| `TrackingPluginOptions` | `ScopePluginOptions` |

**To migrate:** it is a find-and-replace on the names above. Nothing about the arguments changed except the option covered next.

## Breaking: `db.unscoped` takes a registered reason

Before, `db.untracked` was a bare property — an invisible bypass at the call site.

```ts
// 1.x
db.untracked.insert(posts).values(row)
```

Now it is a function, and the reason must be registered up front:

```ts
const db = scopedDb(raw, {
  guard,
  resources,
  unscoped: ['seeders', 'jobs/sweep'],
})

db.unscoped('seeders').select().from(posts)   // ✓
db.unscoped('quick fix')                      // ✗ throws — not registered
db.unscoped                                   // ✗ throws — bare access is gone
```

Omit `unscoped` and nothing may bypass. `grep unscoped` now lists every bypass in a codebase.

It only matters **inside a guarded request** — that is the only time a filter is active. A seeder or job that never runs a guard is unfiltered already.

## Breaking: `db.query` throws on an unfilterable relation

Drizzle exposes `where` on the root config and on `many` relations only. A `one` relation pointing at a filtered table cannot be narrowed, so it throws rather than returning rows the grant denies:

```ts
db.query.comments.findMany({ with: { article: true } })
// MisconfiguredError: relation "article" is a one-relation on a filtered resource,
// and Drizzle exposes no where for it — the rows cannot be narrowed.
```

It throws **synchronously**, at the call site.

**To migrate:** load that relation with `db.select()` and a join — joins are filtered — or register a reason and use `db.unscoped`. `many` relations are filtered recursively and need no change.

## Security fixes in this release

Every integration filtered reads and left writes alone, so a grant that narrowed what a subject could read did not narrow what it could destroy. All three now satisfy the same executable contract — `runQueryIntegrationContractSuite` (Q1–Q7) in `@kyrobit/kyroguard/testing`. A new integration that skips a clause fails CI rather than shipping a quiet gap.

| Path | Before | Now |
| --- | --- | --- |
| Drizzle `db.update()` / `db.delete()` | unfiltered | carries the same filter as `db.select()` |
| Drizzle `.innerJoin(table)` | unfiltered — a join returned rows the root query hid | filtered in the `ON` condition, so a `leftJoin` keeps its left rows |
| Drizzle `db.query.*` | unfiltered — the relational API bypassed everything | filtered like `db.select()` |
| Prisma `updateMany` / `deleteMany` | unfiltered | filtered |
| Prisma single `update` / `delete` under a closed filter | `{ NOT: {} }` folds to *no condition* inside a `WhereUniqueInput` — the write landed on a denied row | a field-level impossible predicate; the write finds nothing |
| Mongoose `update*` / `delete*` | unfiltered | filtered |

A filter belongs to the **table**, not to how you reached it.

## Adapter authors

`StorageAdapter` lost `recordOwnership`, `isOwner`, `removeOwnership`, `getAccess` and `removeAccess`. `ListFilters` lost `owned`, `inTenant` and `granted` — it now holds only `or(fragments)` and `none()`, used when a subject holds one policy under two scopes. `AdapterCapabilities` lost `autoOwnershipTracking`.

Contract clauses S13, S21, S22 and S23 are retired. Numbers are stable identifiers, so the retired ones leave gaps rather than renumbering the rest. See [Custom adapters](/guide/custom-adapters).

## If you do not use scopes

Nothing changes except `db.unscoped`, the `requirePolicy` signature, and the removal of insert tracking. Without scopes every filter resolves to `all`, so the filtering paths return your queries untouched.
