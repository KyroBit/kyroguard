# Groups

Groups are job titles — what other systems call roles. Define them in one file:

```ts
// src/kyroguard/groups/admin.ts
import type { GroupsDefinition } from '@kyrobit/kyroguard'

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
```

The why is in the data. A teacher updates only the grades they entered. The coordinator updates any grade in the school.

Export the object as `groups`. Point [`kyroguard.config.ts`](/reference/configuration) at this file. `npx kyroguard sync` seeds it into the database ([Sync](/guide/sync)).

Assign a group and the user holds every policy in it:

```ts
await teachers.assignGroup(user.id, 'teacher')
```

See [Assigning access](/guide/assigning-access).

## `policies` takes three forms

### Everything: `'all'`

```ts
administrator: {
  label: 'Administrator',
  policies: 'all',
}
```

`'all'` grants every policy you defined. New policies join the group on the next sync. Use it for administrator roles — the principal who owns the school is a different concept, covered in [Owners and superusers](/guide/owners).

### A list

```ts
registrar: {
  label: 'Registrar',
  policies: ['students.manage', 'reports.view'],
}
```

Each listed policy is granted without limits. The registrar manages any student record in the office app.

### Per-policy scopes

```ts
teacher: {
  label: 'Teacher',
  policies: { 'grades.view': 'in-tenant', 'grades.enter': 'all', 'grades.update': 'owned' },
}
```

`'all'` means no restriction — every row. `'owned'` limits that policy to rows the user owns. A teacher updates only the grades they entered. `'in-tenant'` limits it to rows of the request's school. See [Scopes](/guide/scopes).

## Dependencies are filled in

`grades.update` depends on `grades.view` — you must see a grade to update it ([Policies](/guide/policies#dependencies)). Sync adds missing dependencies to every group.

A filled-in dependency inherits the scope of the grant that pulled it in. Grant `grades.update` restricted to `'owned'` and `grades.view` arrives restricted to `'owned'` too — never wider. An unrestricted grant that needs the same dependency widens it to unrestricted. Two different named scopes fall back to unrestricted with a sync warning — define the entry explicitly to control it.

Explicit entries always win. The teacher group above lists `grades.view` itself, so the fill never touches it.

## Re-seeding

::: warning Sync replaces each group's policy list
Every sync sets a group's policies to exactly what `groups.ts` says. Changes made anywhere else are lost on the next sync. Keep this file as the single source of truth.
:::

Members are untouched. Re-seeding changes what a group grants, never who has it.

## Turning a group off

```ts
await guard.adapter.upsertGroup({ name: 'teacher', label: 'Teacher', isActive: false })
await guard.cache.clear()
```

Set `isActive: false` and the group grants nothing. Members keep the assignment but lose the policies. Set it back to `true` to restore them.

`guard.cache.clear()` makes the change take effect immediately.

## Next steps

- [Assigning access](/guide/assigning-access) — give users groups and direct grants
- [Scopes](/guide/scopes) — conditions like `'owned'` or `'grading-window'`
- [Sync](/guide/sync) — how seeding runs
