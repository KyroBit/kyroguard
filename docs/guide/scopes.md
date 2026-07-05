# Scopes

A policy answers: can this user do this at all? A scope answers: **yes, but only when…**

- yes, but only **their own** sales
- yes, but only **during opening hours**
- yes, but only **under 5,000**

One policy, different conditions per role. Here are those three rules, for real.

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
  policies: { 'sales.view': 'owned', 'sales.create': 'all', 'sales.void': 'owned' },
},
manager: {
  label: 'Manager',
  policies: { 'sales.view': 'all', 'sales.void': 'all' },
},
```

Each value is a scope name, or `'all'` for no condition — every row. [Ownership](/guide/ownership) explains how sales get owners.

This rule looks at a row, so the void route needs a `resource` resolver — see [Protecting routes](/guide/protecting-routes#scoped-grants-need-a-resource-resolver).

## Rule 2: "Voids only during opening hours."

A fraud rule. It ignores the resource and checks the clock:

```ts
export const businessHours = new Scope('business-hours', 'Business hours', () => {
  const hour = new Date().getHours()
  return hour >= 9 && hour < 21
})
```

A policy can only be granted with scopes it declares ([Policies](/guide/policies#scopes)), so add the new scope to `scopeOptions`:

```ts
// policies.ts
new Policy('sales.void', { dependsOn: ['sales.view'], scopeOptions: [Scope.owned(), businessHours] })
```

```ts
// groups.ts
cashier: { policies: { 'sales.void': 'business-hours' } }
```

No resolver needed — the condition lives entirely in the grant. A void at 23:00 gets a 403. The same request at noon passes.

## Rule 3: "Cashiers void sales under 5,000."

The scope loads the sale and checks the amount — query your tables however you normally do:

```ts
export const smallSale = new Scope('small-sale', 'Under 5,000', async (user, resource) => {
  if (!resource) return false // row rule: no row, no pass
  const [sale] = await db.select().from(sales).where(eq(sales.id, resource.id))
  return (sale?.total ?? Infinity) < 5000
})
```

Declare it in the policy's `scopeOptions` and grant it, exactly like rule 2: `'sales.void': 'small-sale'`. Written as a scope, the rule is one line in the groups file — not an `if` buried in a handler. A grant carries one scope name; to combine rules, call other scopes' `check` inside one scope.

## When do you need a resource resolver?

| The rule asks about… | Resolver | Example |
|---|---|---|
| the row being touched | yes | own sale, under 5,000 |
| anything else — time, the user, your data | no | opening hours |

Row rules must fail closed: return `false` when `resource` is `null`. `Scope.owned()` already does. Denied requests get the standard guard responses — see [Protecting routes](/guide/protecting-routes#the-four-outcomes).

## Filtering lists

A guard answers "may this user touch **this** row." A list endpoint asks the other question — *which rows?*

### Automatic filtering

On a guarded route, the answer is automatic. When the guard allows, reads of that policy's resource are filtered by the same grant:

```ts
app.get('/sales', { preHandler: staff.requirePolicy('sales.view') }, async () => {
  return db.select().from(sales).orderBy(desc(sales.createdAt)).limit(20)
})
```

The cashier's `'owned'` grant returns twenty of *their* sales. The manager's `'all'` grant reads unfiltered. No grant never reaches the query — the guard already answered 403.

The filter follows the guard's policy, not the table. Your own `where` still applies on top. Reads outside a guarded route — seeders, jobs, unguarded handlers — are never auto-filtered. Scope checks themselves always see the unfiltered table. Per-ORM details: [Drizzle](/reference/drizzle#how-selects-are-filtered), [Prisma](/reference/prisma#what-gets-filtered), [Mongoose](/reference/mongoose).

### When you want the filter in hand

For raw SQL, aggregations, or an unguarded route, ask for the filter yourself:

```ts
app.get('/sales', async req => {
  const f = await staff.filterFor(req, 'sales.view')
  if (f.kind === 'none') return [] // nothing qualifies — skip the query
  return db.select().from(sales)
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

Your own conditions go alongside: `and(eq(sales.status, 'open'), f.where as SQL)`. Condition scopes fold too: at noon `business-hours` means no restriction, at 23:00 it means `none`. No grant at all is also `none`, with `reason: 'no-policy'`; branch on it for a 403 instead of `[]`. Full contract in the [reference](/reference/core-api#filterfor).

::: warning
Never spread `f.where` into another object — later keys can overwrite earlier ones and quietly widen access.
:::

### Filters for custom row scopes

The built-ins filter lists out of the box. A custom row scope takes its filter as the fourth constructor argument — the same rule, as a condition your ORM understands:

```ts
export const smallSale = new Scope(
  'small-sale',
  'Under 5,000',
  async (user, resource) => { /* the check from Rule 3 */ },
  () => ({ where: lt(sales.total, 5000) }),
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
