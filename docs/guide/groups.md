# Groups

A group is a named bundle of policies — essentially a role. Instead of assigning a dozen individual policies to every new user, you assign a group and they get everything in it.

---

## Defining groups

```ts
// src/rbac/groups.ts
export const groups = {
  admin: {
    label:    'Admin',
    policies: 'all',
  },
  cashier: {
    label:    'Cashier',
    policies: ['transaction.view', 'transaction.create'],
  },
  teller: {
    label: 'Teller',
    policies: {
      'transaction.view':   null,           // unrestricted
      'transaction.create': null,           // unrestricted
      'transaction.void':   'branch-owned', // scope check must pass
    },
  },
}
```

---

## Three ways to define policies

| Format | Type | When to use |
|--------|------|-------------|
| `'all'` | string | Every policy in this portal. Great for admin/superuser groups. |
| `string[]` | array | A specific list of policy names, all unrestricted (`null` scope). |
| `Record<string, scope \| null>` | object | A specific list where each policy has its own scope or `null`. |

`'all'` only captures policies from the portal this groups file is paired with in `rbac.config.ts`. In a multi-portal project, `'all'` inside the `branch` groups file assigns only branch policies — never admin or cashier policies.

---

## Scoped group policies

When some policies in a group should be scope-restricted, use the object format:

```ts
export const groups = {
  author: {
    label: 'Author',
    policies: {
      'blog.read':   null,            // can read any post
      'blog.create': null,            // can create freely
      'blog.update': 'written-by-me', // can only update their own posts
      'blog.delete': 'written-by-me', // can only delete their own posts
    },
  },
}
```

The scope name must match a `Scope` instance attached to the relevant `ResourceDefinition`. See [Scopes](./scopes).

---

## Syncing groups

`rbac sync` pushes your groups to the database and replaces their policy assignments to match your definition. Your groups file is always the source of truth.

```bash
bunx rbac sync
```

It's safe to run on every deploy — existing group memberships (which users belong to which groups) are not affected. Only the group definitions (which policies a group carries) are updated.

---

## Dynamic groups

Groups created at runtime — for example through an admin UI — are not touched by `rbac sync`. The sync only manages groups defined in your config file.

---

**Next:** [Configuration](./configuration)
