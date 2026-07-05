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

The label is the display name for your admin screens. It is the action part of the name, capitalized — admin screens group permissions by resource, so the label only needs the verb:

```ts
new Policy('sales.create')    // label: "Create"
new Policy('sales.mark-paid') // label: "Mark paid"
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

`scopeOptions` lists the conditions this policy may be granted with. `Scope.owned()` lets a cashier void only their own sales ([Scopes](/guide/scopes)).

The list is enforced. Granting a scope the policy does not declare fails, at sync and at assignment ([Errors](/reference/errors#unknownscopeerror)).

## A complete policies.ts

```ts
// src/rbac/policies.ts
import { Policy, Scope } from '@kyrobit/rbac'
import type { ResourceDefinition } from '@kyrobit/rbac'

export const resources: ResourceDefinition[] = [
  {
    type: 'sale',
    // table: sales,        // your Drizzle table or Mongoose model (optional):
    //                      // enables ownership tracking and read filtering
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

`type` names the resource for scoped checks and ownership. `table` is optional — set it to record who created each row ([Ownership](/guide/ownership)). Reads on guarded routes are then filtered automatically ([Scopes](/guide/scopes#automatic-filtering)).

## Next steps

- [Groups](/guide/groups) — bundle policies into job titles
- [Sync](/guide/sync) — push policies to the database
- [Protecting routes](/guide/protecting-routes) — check policies in your app
