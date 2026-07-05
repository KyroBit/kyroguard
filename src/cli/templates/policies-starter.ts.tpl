import { Policy, Scope } from '@kyrobit/rbac'
import type { ResourceDefinition } from '@kyrobit/rbac'

// Starter resource — replace with your own, then run `rbac sync`.
// Policy names are UNQUALIFIED: the portal prefix is added automatically.
export const resources: ResourceDefinition[] = [
  {
    type: 'post',
    // table: posts, // link your Drizzle table / Mongoose model to enable
    //               // ownership auto-tracking and query scoping
    policies: [
      new Policy('posts.read'),
      new Policy('posts.create', 'Create posts', ['posts.read']),
      new Policy('posts.update', 'Update posts', ['posts.read'], [Scope.owned()]),
      new Policy('posts.delete', 'Delete posts', ['posts.read'], [Scope.owned()]),
    ],
  },
]
