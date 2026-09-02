import type { GroupsDefinition } from '@kyrobit/kyroguard'

// Seeded by `kyroguard sync` (replace-all per group). Policy names are UNQUALIFIED —
// the domain prefix is added automatically. A scope value is 'all' for no restriction,
// or the name of a scope the policy declares in its scopeOptions.
export const groups: GroupsDefinition = {
  teacher: {
    label: 'Teacher',
    policies: {
      'grades.view': 'all',
      'grades.enter': 'all',
      'grades.update': 'entered',
    },
  },
  coordinator: {
    label: 'Coordinator',
    policies: {
      'grades.view': 'all',
      'grades.update': 'all',
      'grades.delete': 'all',
    },
  },
}
