# Policies

A policy is one permission.

```ts
import { Policy } from '@kyrobit/rbac'

new Policy('sales.create')
```

That is a complete policy. Routes check it. Groups bundle it. You grant it to staff.

Only the name is required. Everything else — label, dependencies, scopes — is optional, passed as an options object. Each gets a section below.

## Names

```ts
new Policy('sales.view')
new Policy('sales.create')
new Policy('products.update')
```

Name policies `resource.action`. The name is what you check on a route:

```ts
app.get('/sales', { preHandler: staff.requirePolicy('sales.view') }, listSales)
```

Write names without a domain prefix. Domains add theirs for you. See [Multi-tenancy](/guide/multi-tenancy).

## Labels

The label is the display name for your admin screens. It is derived from the name:

```ts
new Policy('sales.create')        // label: "Create sales"
new Policy('blog-category.read')  // label: "Read blog category"
```

Pass your own when the derived one reads wrong:

```ts
new Policy('sales.create', 'Record a sale')
// or in the options form:
new Policy('sales.create', { label: 'Record a sale' })
```

## Dependencies

```ts
new Policy('sales.void', { dependsOn: ['sales.view'] })
```

You must see a sale to void it. `dependsOn` declares that once. At sync, every group that has `sales.void` gets `sales.view` added. `sales.create` depends on `sales.view` the same way. See [Sync](/guide/sync).

Dependencies chain:

```ts
new Policy('sales.refund', { dependsOn: ['sales.void'] })
```

A group with `sales.refund` also gets `sales.void` and `sales.view`.

A filled-in dependency inherits the scope of the grant that pulled it in ([Groups](/guide/groups#dependencies-are-filled-in)).

A dependency must name a policy you defined. Sync fails if it does not.

## Scopes

```ts
import { Scope } from '@kyrobit/rbac'

new Policy('sales.void', { dependsOn: ['sales.view'], scopeOptions: [Scope.owned()] })
```

The fourth argument, `scopeOptions`, lists the row-level limits this policy allows. With `Scope.owned()`, a cashier granted `'owned'` access voids only their own sales. A manager granted it without a scope voids any sale ([Scopes](/guide/scopes)).

## A complete policies.ts

```ts
// src/rbac/policies.ts
import { Policy, Scope } from '@kyrobit/rbac'
import type { ResourceDefinition } from '@kyrobit/rbac'

export const resources: ResourceDefinition[] = [
  {
    type: 'sale',
    // table: sales,  // your Drizzle table or Mongoose model (optional):
    //                // enables ownership tracking and query scoping
    policies: [
      new Policy('sales.view'),
      new Policy('sales.create', { dependsOn: ['sales.view'] }),
      new Policy('sales.void', { dependsOn: ['sales.view'], scopeOptions: [Scope.owned()] }),
    ],
  },
  {
    type: 'product',
    policies: [
      new Policy('products.view'),
      new Policy('products.update', { dependsOn: ['products.view'] }),
    ],
  },
]
```

Export the array as `resources`. Point [`rbac.config.ts`](/reference/configuration) at this file. Run `npx rbac sync` to push it to the database.

`type` names the resource for scoped checks and ownership. `table` is optional. Set it on `sale` to record who rang up each sale ([Ownership](/guide/ownership)). That record is what lets a cashier void only their own sales.

## Next steps

- [Groups](/guide/groups) — bundle policies into job titles
- [Sync](/guide/sync) — push policies to the database
- [Protecting routes](/guide/protecting-routes) — check policies in your app
