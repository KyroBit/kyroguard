# Groups

Groups are job titles. Define them in one file:

```ts
// src/rbac/groups.ts
import type { GroupsDefinition } from '@kyrobit/rbac'

export const groups: GroupsDefinition = {
  cashier: {
    label: 'Cashier',
    policies: {
      'sales.view': 'owned',
      'sales.create': 'all',
      'sales.void': 'owned',
    },
  },
  manager: {
    label: 'Manager',
    policies: ['sales.view', 'sales.create', 'sales.void', 'products.view', 'products.update'],
  },
}
```

The why is in the data. A cashier voids only their own sales. A manager voids any sale.

Export the object as `groups`. Point [`rbac.config.ts`](/reference/configuration) at this file. `npx rbac sync` seeds it into the database ([Sync](/guide/sync)).

Assign a group and the user holds every policy in it:

```ts
await staff.assignGroup(user.id, 'cashier')
```

See [Assigning access](/guide/assigning-access).

## `policies` takes three forms

### Everything: `'all'`

```ts
admin: {
  label: 'Administrator',
  policies: 'all',
}
```

`'all'` grants every policy you defined. New policies join the group on the next sync. Use it for administrator roles — the owner of the business is a different concept, covered in [Owners and superusers](/guide/owners).

### A list

```ts
manager: {
  label: 'Manager',
  policies: ['sales.view', 'sales.create', 'sales.void', 'products.view', 'products.update'],
}
```

Each listed policy is granted without limits. A manager voids any sale in the store.

### Per-policy scopes

```ts
cashier: {
  label: 'Cashier',
  policies: { 'sales.view': 'owned', 'sales.create': 'all', 'sales.void': 'owned' },
}
```

`'all'` means no restriction — every row. `'owned'` limits that policy to rows the user owns. A cashier voids only the sales they rang up. See [Scopes](/guide/scopes).

## Dependencies are filled in

`sales.void` depends on `sales.view` — you must see a sale to void it ([Policies](/guide/policies#dependencies)). Sync adds missing dependencies to every group.

A filled-in dependency inherits the scope of the grant that pulled it in. Grant `sales.void` restricted to `'owned'` and `sales.view` arrives restricted to `'owned'` too — never wider. An unrestricted grant that needs the same dependency widens it to unrestricted. Two different named scopes fall back to unrestricted with a sync warning — define the entry explicitly to control it.

Explicit entries always win. The cashier group above lists `sales.view` itself, so the fill never touches it.

## Re-seeding

::: warning Sync replaces each group's policy list
Every sync sets a group's policies to exactly what `groups.ts` says. Changes made anywhere else are lost on the next sync. Keep this file as the single source of truth.
:::

Members are untouched. Re-seeding changes what a group grants, never who has it.

## Turning a group off

```ts
await rbac.adapter.upsertGroup({ name: 'cashier', label: 'Cashier', isActive: false })
await rbac.cache.clear()
```

Set `isActive: false` and the group grants nothing. Members keep the assignment but lose the policies. Set it back to `true` to restore them.

`rbac.cache.clear()` makes the change take effect immediately.

## Next steps

- [Assigning access](/guide/assigning-access) — give staff groups and direct grants
- [Scopes](/guide/scopes) — conditions like `'owned'` or `'business-hours'`
- [Sync](/guide/sync) — how seeding runs
