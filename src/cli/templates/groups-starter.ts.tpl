import type { GroupsDefinition } from '@kyrobit/rbac'

// Seeded by `rbac sync` (replace-all per group). Policy names are UNQUALIFIED —
// the domain prefix is added automatically. Scope values: null = unrestricted,
// 'owned' = only rows the subject owns.
export const groups: GroupsDefinition = {
  cashier: {
    label: 'Cashier',
    policies: {
      'sales.view': 'owned',
      'sales.create': null,
      'sales.void': 'owned',
    },
  },
  manager: {
    label: 'Manager',
    policies: {
      'sales.view': null,
      'sales.create': null,
      'sales.void': null,
      'products.view': null,
      'products.update': null,
    },
  },
}
