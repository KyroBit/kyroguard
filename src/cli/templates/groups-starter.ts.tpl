import type { GroupsDefinition } from '@kyrobit/kyroguard'

// Seeded by `kyroguard sync` (replace-all per group). Policy names are UNQUALIFIED —
// the domain prefix is added automatically. Scope values: 'all' = no restriction,
// 'owned' = only rows the subject created, 'in-tenant' = rows in the request's tenant.
export const groups: GroupsDefinition = {
  teacher: {
    label: 'Teacher',
    policies: {
      'grades.view': 'in-tenant',
      'grades.enter': 'all',
      'grades.update': 'owned',
    },
  },
  coordinator: {
    label: 'Coordinator',
    policies: {
      'grades.view': 'in-tenant',
      'grades.update': 'in-tenant',
      'grades.delete': 'in-tenant',
    },
  },
}
