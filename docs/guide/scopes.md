# Scopes

A policy answers: can this user do this at all? A scope answers: **yes, but only when…**

- yes, but only the grades **they entered**
- yes, but only **while the grading window is open**
- yes, but only **before results are published**

One policy, different conditions per role. Here are those three rules, for real.

## Rule 1: "A teacher updates only the grades they entered. The coordinator updates any grade in the school."

`Scope.owned()` is built in. It passes when the user created the row:

```ts
// policies.ts — the policy lists the scopes it may be granted with
new Policy('grades.update', { dependsOn: ['grades.view'], scopeOptions: [Scope.owned(), Scope.inTenant()] })
```

```ts
// groups.ts — the same policy, a different condition per role
teacher: {
  label: 'Teacher',
  policies: { 'grades.view': 'in-tenant', 'grades.enter': 'all', 'grades.update': 'owned' },
},
coordinator: {
  label: 'Coordinator',
  policies: { 'grades.view': 'in-tenant', 'grades.update': 'in-tenant', 'grades.delete': 'in-tenant' },
},
```

Each value is a scope name, or `'all'` for no condition — every row. [Ownership](/guide/ownership) explains how grades get owners; `'in-tenant'` — any grade in the request's school — is covered in [Multi-tenancy](/guide/multi-tenancy).

This rule looks at a row. On `PATCH /grades/:id` the guard finds it by itself — the policy's resource type plus the route's `:id` param. When the id lives anywhere else, pass a `resource` resolver — see [Protecting routes](/guide/protecting-routes).

## Rule 2: "Grades change only while the grading window is open."

A deadline rule. It ignores the resource and checks the calendar:

```ts
export const gradingWindow = new Scope('grading-window', 'Grading window', () => {
  const now = new Date()
  return now >= term.gradingOpens && now <= term.gradingCloses
})
```

A policy can only be granted with scopes it declares ([Policies](/guide/policies#scopes)), so add the new scope to `scopeOptions`:

```ts
// policies.ts
new Policy('grades.update', { dependsOn: ['grades.view'], scopeOptions: [Scope.owned(), gradingWindow] })
```

```ts
// groups.ts
teacher: { policies: { 'grades.update': 'grading-window' } }
```

No resolver needed — the condition lives entirely in the grant. An update after the window closes gets a 403. The same request the day before passes.

## Rule 3: "Grades stay editable until the results are published."

The scope loads the grade and checks whether results went out — query your tables however you normally do:

```ts
export const unpublished = new Scope('unpublished', 'Not yet published', async (user, resource) => {
  if (!resource) return false // row rule: no row, no pass
  const [grade] = await db.select().from(grades).where(eq(grades.id, resource.id))
  return grade ? !grade.published : false
})
```

Declare it in the policy's `scopeOptions` and grant it, exactly like rule 2: `'grades.update': 'unpublished'`. Written as a scope, the rule is one line in the groups file — not an `if` buried in a handler. A grant carries one scope name; to combine rules, call other scopes' `check` inside one scope.

## When does a rule need the row?

| The rule asks about… | The row | Example |
|---|---|---|
| the row being touched | yes | the grade they entered, unpublished results |
| anything else — time, the user, your data | no | the grading window |

Row rules must fail closed: return `false` when `resource` is `null`. `Scope.owned()` already does. On a `/:id` route the guard resolves the row on its own; when the id lives elsewhere, pass a `resource` resolver — see [Protecting routes](/guide/protecting-routes). Denied requests get the standard guard responses — see [Protecting routes](/guide/protecting-routes#the-four-outcomes).

## Filtering lists

A guard answers "may this user touch **this** row." A list endpoint asks the other question — *which rows?*

### Automatic filtering

On a guarded route, the answer is automatic. When the guard allows, reads of that policy's resource are filtered by the same grant:

```ts
app.get('/grades', { preHandler: teachers.requirePolicy('grades.view') }, async () => {
  return db.select().from(grades).orderBy(grades.student).limit(20)
})
```

The teacher's `'in-tenant'` grant returns twenty grades from their own school. An `'owned'` grant would return only the grades they entered; `'all'` reads unfiltered. No grant never reaches the query — the guard already answered 403.

The filter follows the guard's policy, not the table. Your own `where` still applies on top. Reads outside a guarded route — seeders, jobs, unguarded handlers — are never auto-filtered. Scope checks themselves always see the unfiltered table. Per-ORM details: [Drizzle](/reference/drizzle#how-selects-are-filtered), [Prisma](/reference/prisma#what-gets-filtered), [Mongoose](/reference/mongoose).

### When you want the filter in hand

For raw SQL, aggregations, or an unguarded route, ask for the filter yourself:

```ts
app.get('/grades', async req => {
  const f = await teachers.filterFor(req, 'grades.view')
  if (f.kind === 'none') return [] // nothing qualifies — skip the query
  return db.select().from(grades)
    .where(f.kind === 'all' ? undefined : f.where as SQL)
    .limit(20)
})
```

The answer is one of three:

| Kind | Meaning | What to do |
|---|---|---|
| `{ kind: 'all' }` | The grant has no row restriction | Query unfiltered |
| `{ kind: 'none', reason }` | Nothing qualifies right now | Return `[]` — skip the database |
| `{ kind: 'where', where }` | A native condition for your ORM | `AND` it into your query |

Your own conditions go alongside: `and(eq(grades.subject, 'maths'), f.where as SQL)`. Condition scopes fold too: while the window is open `grading-window` means no restriction, after it closes it means `none`. No grant at all is also `none`, with `reason: 'no-policy'`; branch on it for a 403 instead of `[]`. Full contract in the [reference](/reference/core-api#filterfor).

::: warning
Never spread `f.where` into another object — later keys can overwrite earlier ones and quietly widen access.
:::

### Filters for custom row scopes

The built-ins filter lists out of the box. A custom row scope takes its filter as the fourth constructor argument — the same rule, as a condition your ORM understands:

```ts
export const unpublished = new Scope(
  'unpublished',
  'Not yet published',
  async (user, resource) => { /* the check from Rule 3 */ },
  () => ({ where: eq(grades.published, false) }),
)
```

The check guards single rows; the filter powers lists. A row scope without a filter contributes no rows — lists stay empty rather than leak. Keep the halves honest with one `assertScopeParity` test per scope — see [Testing](/reference/testing).

## The built-in scopes

| Scope | Name | Passes when |
|---|---|---|
| `Scope.owned()` | `owned` | the user created the row — [Ownership](/guide/ownership) |
| `Scope.granted()` | `granted` | the row was shared with the user — [the access API](/guide/ownership#the-access-api) |
| `Scope.inTenant()` | `in-tenant` | the row belongs to the request's tenant — [Multi-tenancy](/guide/multi-tenancy) |

All three guard single rows and filter lists.

## Next steps

- [Ownership](/guide/ownership) — how rows get owners, and sharing chosen rows.
- [Assigning access](/guide/assigning-access) — the scope travels with the grant.
- [Owners and superusers](/guide/owners) — when no scope is enough: the owner.
