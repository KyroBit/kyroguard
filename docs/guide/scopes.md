# Scopes

A policy answers: can this user do this at all? A scope answers: **yes, but only when…**

- yes, but only the grades **they entered**
- yes, but only **while the grading window is open**
- yes, but only **before results are published**

One policy, different conditions per role. A scope is a function you write against **your own tables**; kyroguard turns it into a condition on every query for that resource — reads, updates and deletes alike.

```ts
new Scope(name, label, (subject, ctx) => true | false | { where })
```

| It returns | Meaning |
|---|---|
| `true` | no restriction — the query runs as written |
| `false` | no rows — the query is emptied |
| `{ where }` | a native condition for your ORM, ANDed into the query |

Here are those three rules, for real.

## Rule 1: "A teacher updates only the grades they entered. The coordinator updates any grade in the school."

The rule lives in a column you already have — `grades.entered_by`:

```ts
// scopes.ts
export const entered = new Scope('entered', 'Entered by the teacher', subject => ({
  where: eq(grades.enteredBy, subject.id),
}))

export const inSchool = new Scope('in-school', 'In the request school', subject => {
  if (!subject.tenant_id) return false
  return { where: eq(grades.schoolId, subject.tenant_id) }
})
```

```ts
// policies.ts — the policy lists the scopes it may be granted with
new Policy('grades.update', { dependsOn: ['grades.view'], scopeOptions: [entered, inSchool] })
```

```ts
// groups.ts — the same policy, a different condition per role
teacher: {
  label: 'Teacher',
  policies: { 'grades.view': 'in-school', 'grades.enter': 'all', 'grades.update': 'entered' },
},
coordinator: {
  label: 'Coordinator',
  policies: { 'grades.view': 'in-school', 'grades.update': 'in-school', 'grades.delete': 'in-school' },
},
```

Each value is a scope name, or `'all'` for no condition — every row.

On `PATCH /grades/:id`, the teacher's `UPDATE` now carries `WHERE id = :id AND entered_by = :them`. A grade someone else entered matches nothing, the update touches no rows, and your handler answers 404. You write no check.

## Rule 2: "Grades change only while the grading window is open."

A deadline rule. It ignores the rows entirely and reads the calendar:

```ts
export const gradingWindow = new Scope('grading-window', 'Grading window', () => {
  const now = new Date()
  return now >= term.gradingOpens && now <= term.gradingCloses
})
```

A policy can only be granted with scopes it declares ([Policies](/guide/policies#scopes)), so add the new scope to `scopeOptions`:

```ts
// policies.ts
new Policy('grades.update', { dependsOn: ['grades.view'], scopeOptions: [entered, gradingWindow] })
```

```ts
// groups.ts
teacher: { policies: { 'grades.update': 'grading-window' } }
```

While the window is open the scope returns `true` and queries run untouched. After it closes it returns `false`, every grade query for that grant comes back empty, and the update writes nothing.

## Rule 3: "Grades stay editable until the results are published."

A column on the row again — so it is a `where`:

```ts
export const unpublished = new Scope('unpublished', 'Not yet published', () => ({
  where: eq(grades.published, false),
}))
```

Declare it in the policy's `scopeOptions` and grant it exactly like rule 2: `'grades.update': 'unpublished'`. Written as a scope, the rule is one line in the groups file — not an `if` buried in a handler.

## Scopes are your code, over your schema

kyroguard stores no rows of its own about your data. Which column carries the tenant, which column carries the author, whether a soft-deleted row counts — all of that is yours, and a scope is where you say it. That also means the columns must exist: adding `school_id` to `grades`, and keeping it filled on insert, is your migration and your handler's job.

The scope receives `(subject, ctx)`. `subject` is whatever your `getSubject` returned. `ctx` is `{ db, adapter, resource }` — the db handle you passed to `createGuard`, the storage adapter, and the resource definition being queried. A scope may query the db; those queries are never filtered by the scope being built, so it cannot deadlock on itself.

## One question, one answer

There is no separate single-row check. The scope narrows the query, so:

- a **read** of a row the scope excludes returns nothing → your handler 404s
- an **update** or **delete** naming it matches no rows → nothing is written
- a **list** returns only the rows the scope admits

The guard itself answers a smaller question: does this subject hold this policy at all? No → 403. Yes → the request proceeds with the scope's condition attached. Denied requests get the standard guard responses — see [Protecting routes](/guide/protecting-routes#the-outcomes).

## Two scopes on one policy

A subject can hold the same policy twice — once directly, once through a group — with a different scope each time. Those scopes **union**: the subject sees the rows either one admits, combined with your backend's `OR`. One `'all'` grant anywhere wins outright and the query runs unfiltered.

## Automatic filtering

On a guarded route the condition is attached for you. When the guard allows, queries against that policy's resource carry the grant's scope:

```ts
app.get('/grades', { preHandler: teachers.requirePolicy('grades.view') }, async () => {
  return db.select().from(grades).orderBy(grades.student).limit(20)
})
```

The teacher's `'in-school'` grant returns twenty grades from their own school. An `'entered'` grant returns only the grades they entered; `'all'` reads unfiltered.

The filter follows the guard's policy, not the table. Your own `where` still applies on top. Queries outside a guarded route — seeders, jobs, unguarded handlers — are never filtered. Per-ORM details: [Drizzle](/reference/drizzle#how-selects-are-filtered), [Prisma](/reference/prisma#what-gets-filtered), [Mongoose](/reference/mongoose).

## When you want the condition in hand

For raw SQL, aggregations, or an unguarded route, ask for it yourself:

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

Your own conditions go alongside: `and(eq(grades.subject, 'maths'), f.where as SQL)`. No grant at all is also `none`, with `reason: 'no-policy'`; branch on it for a 403 instead of `[]`. Full contract in the [reference](/reference/core-api#filterfor).

::: warning
Never spread `f.where` into another object — later keys can overwrite earlier ones and quietly widen access.
:::

## Next steps

- [Assigning access](/guide/assigning-access) — the scope travels with the grant.
- [Owners and superusers](/guide/owners) — when no scope is enough: the owner.
