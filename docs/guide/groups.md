# Groups

Groups are roles. Define them in one file:

```ts
// src/rbac/groups.ts
import type { GroupsDefinition } from '@kyrobit/rbac'

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
  viewer: {
    label: 'Viewer',
    policies: ['posts.read', 'comments.read'],
  },
}
```

Export the object as `groups`. Point [`rbac.config.ts`](/reference/configuration) at this file. `npx rbac sync` seeds it into the database ([Sync](/guide/sync)).

Assign a group and the user holds every policy in it:

```ts
await portal.assignGroup(user.id, 'editor')
```

See [Assigning access](/guide/assigning-access).

`isSystem: true` is a flag for your own admin UI. The library stores it and nothing more.

## `policies` takes three forms

### Everything: `'all'`

```ts
admin: {
  label: 'Administrator',
  policies: 'all',
}
```

`'all'` grants every policy you defined. New policies join the group on the next sync.

### A list

```ts
viewer: {
  label: 'Viewer',
  policies: ['posts.read', 'comments.read'],
}
```

Each listed policy is granted without limits.

### Per-policy scopes

```ts
editor: {
  label: 'Editor',
  policies: { 'posts.read': null, 'posts.update': 'owned' },
}
```

`null` means no limit. `'owned'` limits that policy to rows the user owns. See [Scopes](/guide/scopes).

## Re-seeding

::: warning Sync replaces each group's policy list
Every sync sets a group's policies to exactly what `groups.ts` says. Changes made anywhere else are lost on the next sync. Keep this file as the single source of truth.
:::

Members are untouched. Re-seeding changes what a group grants, never who has it.

## Turning a group off

```ts
await rbac.adapter.upsertGroup({ name: 'editor', label: 'Editor', isActive: false })
await rbac.cache.clear()
```

Set `isActive: false` and the group grants nothing. Members keep the assignment but lose the policies. Set it back to `true` to restore them.

`rbac.cache.clear()` makes the change take effect immediately.

## Next steps

- [Assigning access](/guide/assigning-access) — give users groups and direct grants
- [Scopes](/guide/scopes) — row-level limits like `'owned'`
- [Sync](/guide/sync) — how seeding runs
