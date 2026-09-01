# Upgrading to 2.0

Version 2 closes a set of holes across every ORM integration where a scoped grant
could still reach rows it did not allow. If you use scopes, treat this as a
security update.

Two changes need edits in your code. Everything else is automatic.

## What was leaking

Every integration filtered reads and left writes alone, so a grant that narrowed
what a subject could read did not narrow what it could destroy. That is worse than
no filtering: the reads look safe.

All three now satisfy the same executable contract — `runQueryIntegrationContractSuite`
(Q1–Q7) in `@kyrobit/kyroguard/testing`. A new integration that skips a clause fails
CI rather than shipping a quiet gap.

| Integration | Reads | Writes before | Writes now |
| --- | --- | --- | --- |
| Drizzle `trackedDb` | filtered | **unfiltered** | filtered |
| Prisma `trackingExtension` | filtered | **unfiltered** | filtered |
| Mongoose `trackingPlugin` | filtered | **unfiltered** | filtered |

### Drizzle specifics

| Path | Before | Now |
| --- | --- | --- |
| `db.update()` / `db.delete()` | unfiltered — a grant limited to your own rows could still write to every row | carries the same filter as `db.select()` |
| `.innerJoin(table)` on a registered table | unfiltered — a join returned rows the root query hid | the joined table carries its own filter, in the `ON` condition |
| `db.query.*` | unfiltered — the relational API bypassed everything | filtered like `db.select()` |
| `insert().values().onConflictDoUpdate()` | the conflicting writer took ownership of the existing row | only rows confirmed by `.returning()` are attributed |
| `insert().select()` | no ownership recorded | recorded from `.returning()` |

A filter belongs to the **table**, not to how you reached it. Registered tables are
now filtered through `from()`, joins, `update`, `delete` and `db.query` alike.

## Breaking: `db.untracked` takes a registered reason

Before, `db.untracked` was a bare property — an invisible bypass at the call site.

```ts
// before
db.untracked.insert(posts).values(row)
```

Now it is a function, and the reason must be registered up front:

```ts
const db = trackedDb(raw, {
  guard,
  resources,
  untracked: ['seeders', 'jobs/sweep'],
})

db.untracked('seeders').insert(posts).values(row)   // ✓
db.untracked('quick fix')                            // ✗ throws — not registered
db.untracked                                         // ✗ throws — bare access is gone
```

Omit `untracked` and nothing may bypass. Adding a bypass is now a config change
that shows up in review, and `grep untracked` lists every one in a codebase.

**To migrate:** collect the reasons you need — usually seeders, migrations and
background jobs — register them once, and pass the reason at each call site.

## Breaking: `db.query` throws on an unfilterable relation

Drizzle exposes `where` on the root config and on `many` relations only. A `one`
relation pointing at a filtered table cannot be narrowed, so it now throws rather
than returning rows the grant denies:

```ts
db.query.comments.findMany({ with: { article: true } })
// MisconfiguredError: relation "article" is a one-relation on a filtered resource,
// and Drizzle exposes no where for it — the rows cannot be narrowed.
// Load it with db.select() and a join, or use db.untracked.
```

It throws **synchronously**, at the call site.

**To migrate:** load that relation with `db.select()` and a join — joins are
filtered now — or register a reason and use `db.untracked`.

`many` relations are filtered recursively and need no change.

## Not breaking, but worth knowing

**Bulk routes can be guarded.** A resource resolver may return several refs. Every
one must pass, or the whole call denies — the single-ref behaviour is unchanged.

```ts
requirePolicy('posts.update', {
  resource: req => req.body.ids.map(id => ({ type: 'post', id })),
})
```

An empty list is a 404 rather than a silent allow.

**Left joins keep their semantics.** The joined table's filter goes in the `ON`
condition, so a `leftJoin` still returns its left rows with the joined side null —
it does not collapse into an inner join.

## If you do not use scopes

Nothing changes except `db.untracked`. Without scopes every filter resolves to
`all`, so the new filtering paths return your queries untouched.
