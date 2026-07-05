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

## Next steps

- [Ownership](/guide/ownership) — how rows get owners for `Scope.owned()`.
- [Groups](/guide/groups) — where scoped grants live.
- [Owners and superusers](/guide/owners) — when no scope is enough: the owner.
