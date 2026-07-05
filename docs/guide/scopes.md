# Scopes

A policy answers: can this user do this at all? A scope answers: **yes, but only when…**

- yes, but only **their own** sales
- yes, but only **during opening hours**
- yes, but only **under 5,000**

One policy, different conditions per role. That is the whole idea. Here are those three rules, for real.

## Rule 1: "Cashiers void their own sales. Managers void any."

`Scope.owned()` is built in. It passes when the user created the row:

```ts
// policies.ts — the policy lists the scopes it may be granted with
new Policy('sales.void', { dependsOn: ['sales.view'], scopeOptions: [Scope.owned()] })
```

```ts
// groups.ts — the same policy, a different condition per role
cashier: {
  label: 'Cashier',
  policies: { 'sales.view': 'owned', 'sales.create': null, 'sales.void': 'owned' },
},
manager: {
  label: 'Manager',
  policies: { 'sales.view': null, 'sales.void': null },
},
```

Each value is a scope name, or `null` for no condition. That one file is the org chart: cashiers void what they recorded, managers void anything. [Ownership](/guide/ownership) explains how sales get owners.

This rule looks at a row, so the guard needs to know which row. Give it a `resource` resolver:

::: code-group

```ts [Fastify]
app.post('/sales/:id/void', {
  preHandler: staff.requirePolicy('sales.void', {
    resource: req => ({ type: 'sale', id: (req.params as { id: string }).id }),
  }),
}, voidSale)
```

```ts [Express]
app.post('/sales/:id/void',
  staff.requirePolicy('sales.void', {
    resource: req => ({ type: 'sale', id: req.params.id }),
  }),
  voidSale,
)
```

:::

## Rule 2: "Voids only during opening hours."

A fraud rule. It has nothing to do with any row — the scope checks the clock and ignores the resource:

```ts
export const businessHours = new Scope('business-hours', 'Business hours', () => {
  const hour = new Date().getHours()
  return hour >= 9 && hour < 21
})
```

```ts
// groups.ts
cashier: { policies: { 'sales.void': 'business-hours' } }
```

No resolver on the route. The route stays exactly as it was — the condition lives entirely in the grant. A cashier voiding at 23:00 gets a 403; the same request at noon passes.

## Rule 3: "Cashiers void sales under 5,000. Bigger needs a manager."

The scope loads the sale and checks the amount — query your tables however you normally do:

```ts
import { db } from './db'
import { sales } from './schema'

export const smallSale = new Scope('small-sale', 'Under 5,000', async (user, resource) => {
  if (!resource) return false // row rule: no row, no pass
  const [sale] = await db.select().from(sales).where(eq(sales.id, resource.id))
  return (sale?.total ?? Infinity) < 5000
})
```

Every store has this rule. Written as a scope, it is one line in the groups file — not an `if` buried in a route handler.

## Combining rules

A grant carries one scope name — but a scope is a function, so combine conditions inside it:

```ts
export const cashierVoid = new Scope('cashier-void', 'Own, small, in hours', async (user, resource, ctx) => {
  if (!resource) return false
  if (!businessHours.check(user, resource, ctx)) return false
  if (!(await Scope.owned().check(user, resource, ctx))) return false
  return smallSale.check(user, resource, ctx)
})
```

## When do you need a resource resolver?

| The rule asks about… | Resolver | Example |
|---|---|---|
| the row being touched | yes | own sale, under 5,000 |
| anything else — time, the user, your data | no | opening hours, not on probation |

Row rules must fail closed: return `false` when `resource` is `null`, like the examples above. `Scope.owned()` already does.

## What a denied request gets

A failed check → 403 with `RBAC_SCOPE_DENIED`. A resolver that finds no row → 404. Registering a scope: list it in the policy's allowed scopes (shown in Rule 1) — the [reference](/reference/core-api) has the full `Scope` API.

## Filtering lists

A guard answers "may this user touch **this** row." A list endpoint asks the same grant the other question — *which rows?*

### Automatic filtering

Name the policy that governs reads, on the resource:

```ts
{ type: 'sale', table: sales, list: 'sales.view', policies: [/* ... */] }
```

Plain queries now come back scoped to the logged-in user:

```ts
const rows = await db.select().from(sales).orderBy(desc(sales.createdAt)).limit(20)
// cashier: twenty of their own sales · manager: twenty of anyone's · no grant: empty
```

The ORM integrations do the asking for you: `trackedDb` filters Drizzle selects, the Prisma extension filters `findMany`, `findFirst`, `findUnique` and `count`, the Mongoose plugin filters `find` queries. Every read of a `list` resource gets the user's `sales.view` decision `AND`ed in — your own `where` still applies on top. A list route that forgets to filter can no longer leak rows.

Two doors stay open on purpose. Reads through `db.untracked` — or any handle the integration does not wrap — are never filtered. And queries the engine itself runs while deciding — scope checks, filter halves, resource resolvers — always see the unfiltered table. Reads with no logged-in user (seeders, jobs) also run plainly, like [ownership tracking](/guide/ownership#background-jobs).

### When you want the filter in hand

Automatic filtering applies the decision for you. `filterFor` hands it to you instead — for raw SQL, aggregations, a resource without `list`, or a query you build yourself:

::: code-group

```ts [Fastify]
app.get('/sales', async req => {
  const f = await staff.filterFor(req, 'sales.view')
  if (f.kind === 'none') return [] // nothing qualifies — skip the query
  return db.select().from(sales)
    .where(f.kind === 'all' ? undefined : f.where as SQL)
    .orderBy(desc(sales.createdAt))
    .limit(20)
})
```

```ts [Express]
app.get('/sales', async (req, res) => {
  const f = await staff.filterFor(req, 'sales.view')
  if (f.kind === 'none') return res.json([])
  const rows = await db.select().from(sales)
    .where(f.kind === 'all' ? undefined : f.where as SQL)
    .limit(20)
  res.json(rows)
})
```

:::

The answer is one of three:

| Kind | Meaning | What to do |
|---|---|---|
| `{ kind: 'all' }` | The grant has no row restriction | Query unfiltered |
| `{ kind: 'none', reason }` | Nothing qualifies right now | Return `[]` — skip the database |
| `{ kind: 'where', where }` | A native condition for your ORM | `AND` it into your query |

Your own conditions go alongside: `and(eq(sales.status, 'open'), f.where as SQL)`. Never spread `f.where` into another object — later keys can overwrite earlier ones and quietly widen access.

### The cashier's list

The void guard from Rule 1 already knows cashiers only touch their own sales. On the list route, the cashier's `'sales.view': 'owned'` grant comes back as `{ kind: 'where' }` carrying one EXISTS against the ownership store. The page holds only their own sales — and `LIMIT 20` means twenty of *theirs*, not twenty minus everyone else's.

`filterFor` finds the resource by the policy it defines. The `sale` resource from [Ownership](/guide/ownership) already carries its `table` — that is all the built-in filters need.

### The manager's list

Same route, no new code. The manager's grant is `'sales.view': null` — no condition — so `filterFor` returns `{ kind: 'all' }` and the query runs unfiltered. Nothing built, nothing enumerated, nothing to pay. One grant with a scope and another without? The unrestricted one wins, exactly as it does at the guard.

### Outside business hours

The fraud rule from Rule 2 — `'sales.view': 'business-hours'` — never looks at a row, so it never becomes SQL. At noon it folds to no restriction. At 23:00 it folds to `{ kind: 'none', reason: 'scope-denied' }` and the endpoint returns an empty list without touching the database. The fallback rule makes this free: a scope with no filter half runs its ordinary `check` once, with no resource — `true` means no restriction, `false` means no rows.

No `sales.view` grant at all is also an empty list — `{ kind: 'none', reason: 'no-policy' }`. Lists answer with emptiness where guards answer with errors; only a missing login still throws (401). Want a 403 instead? Branch on it:

```ts
if (f.kind === 'none' && f.reason === 'no-policy') {
  return reply.code(403).send({ code: 'RBAC_POLICY_DENIED' })
}
```

### Filters for custom row scopes

`Scope.owned()` ships its own filter. A custom row scope gets one as the fourth constructor argument — the same rule, written as a condition your ORM understands. Rule 3's scope, with its list half:

```ts
import { lt } from 'drizzle-orm'

export const smallSale = new Scope(
  'small-sale',
  'Under 5,000',
  async (user, resource) => { /* the check from Rule 3 */ },
  () => ({ where: lt(sales.total, 5000) }),
)
```

One scope, two paths: the check guards single rows, the filter powers lists. A row scope without a filter contributes no rows to a list — the list stays empty rather than leaking.

The two halves must agree: a row passes the check exactly when the filtered query returns it. The built-ins agree by construction. For your own filters, one `assertScopeParity` test per scope keeps them honest — see [Testing](/reference/testing).

## Chosen records

Ownership covers rows a user created. For rows someone *picks* — share this report, assign this ticket — grant access directly:

```ts
await rbac.access.grant(amina.id, { type: 'report', id: '7' })
```

`Scope.granted()` is the built-in that checks those grants:

```ts
new Policy('reports.view', { scopeOptions: [Scope.granted()] })

// groups.ts
analyst: { policies: { 'reports.view': 'granted' } },
```

Amina now sees report 7 — at the guard and in her lists — until `rbac.access.revoke(amina.id, { type: 'report', id: '7' })`. [Ownership](/guide/ownership#the-access-api) has the full API.

## The built-in scopes

| Scope | Name | Passes when |
|---|---|---|
| `Scope.owned()` | `owned` | the user created the row — [Ownership](/guide/ownership) |
| `Scope.granted()` | `granted` | the row was shared with the user via `rbac.access.grant()` |
| `Scope.inTenant()` | `in-tenant` | the row belongs to the request's tenant — [Multi-tenancy](/guide/multi-tenancy) |

All three guard single rows and filter lists.

## Next steps

- [Ownership](/guide/ownership) — how rows get owners for `Scope.owned()`, and the access API behind `Scope.granted()`.
- [Assigning access](/guide/assigning-access) — the scope travels with the grant: a group entry, or a direct assignment.
- [Owners and superusers](/guide/owners) — when no scope is enough: the owner.
- [One Scope, Two Paths](/rfc/one-scope-two-paths) — the design notes behind `filterFor`, for the curious.
