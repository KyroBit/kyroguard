import { Policy, Scope } from '@kyrobit/rbac'
import type { ResourceDefinition } from '@kyrobit/rbac'

// Starter resources — replace with your own, then run `rbac sync`.
// Policy names are UNQUALIFIED: the domain prefix is added automatically.
export const resources: ResourceDefinition[] = [
  {
    type: 'sale',
    // table: sales, // link your Drizzle table / Mongoose model to enable
    //               // ownership auto-tracking and query scoping
    policies: [
      new Policy('sales.view'),
      new Policy('sales.create', 'Create sales', ['sales.view']),
      new Policy('sales.void', 'Void sales', ['sales.view'], [Scope.owned()]),
    ],
  },
  {
    type: 'product',
    policies: [
      new Policy('products.view'),
      new Policy('products.update', 'Update products', ['products.view']),
    ],
  },
]
