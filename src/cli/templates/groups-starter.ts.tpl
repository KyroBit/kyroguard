import type { GroupsDefinition } from '@kyrobit/rbac'

// Seeded by `rbac sync` (replace-all per group). Policy names are UNQUALIFIED —
// the domain prefix is added automatically. Scope values: 'all' = no restriction,
// 'owned' = only rows the subject owns.
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
    policies: {
      'sales.view': 'all',
      'sales.create': 'all',
      'sales.void': 'all',
      'products.view': 'all',
      'products.update': 'all',
    },
  },
}
