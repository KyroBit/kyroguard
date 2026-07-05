import type { GroupsDefinition } from '@kyrobit/rbac'

// Seeded by `rbac sync` (replace-all per group). Policy names are UNQUALIFIED —
// the portal prefix is added automatically. Scope values: null = unrestricted,
// 'owned' = only rows the subject owns.
export const groups: GroupsDefinition = {
  admin: {
    label: 'Administrator',
    isSystem: true,
    policies: 'all',
  },
  editor: {
    label: 'Editor',
    policies: {
      'posts.read': null,
      'posts.create': null,
      'posts.update': 'owned',
      'posts.delete': 'owned',
    },
  },
}
