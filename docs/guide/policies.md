# Policies

A policy is one permission.

```ts
import { Policy } from '@kyrobit/rbac'

new Policy('posts.create')
```

That is a complete policy. Routes check it. Groups bundle it. You grant it to users.

Only the name is required. The other three arguments are a label, dependencies, and scopes. Each gets a section below.

## Names

```ts
new Policy('posts.read')
new Policy('posts.create')
new Policy('comments.delete')
```

Name policies `resource.action`. The name is what you check on a route:

```ts
app.get('/posts', { preHandler: portal.requirePolicy('posts.read') }, listPosts)
```

Write names without a portal prefix. Portals add theirs for you. See [Portals](/guide/portals).

## Labels

```ts
new Policy('posts.create', 'Create posts')
```

The label is the display name. Use it in admin screens. Omit it and the action part of the name is used.

## Dependencies

```ts
new Policy('posts.create', 'Create posts', ['posts.read'])
```

`posts.create` is useless without `posts.read`. The third argument, `dependsOn`, declares that once. At sync, every group that has `posts.create` gets `posts.read` added. See [Sync](/guide/sync).

Dependencies chain:

```ts
new Policy('posts.publish', 'Publish posts', ['posts.create'])
```

A group with `posts.publish` also gets `posts.create` and `posts.read`.

A dependency must name a policy you defined. Sync fails if it does not.

## Scopes

```ts
import { Scope } from '@kyrobit/rbac'

new Policy('posts.update', 'Update posts', ['posts.read'], [Scope.owned()])
```

The fourth argument, `scopeOptions`, lists the row-level limits this policy allows. With `Scope.owned()`, a user granted `'owned'` access only passes on their own rows ([Scopes](/guide/scopes)).

## A complete policies.ts

```ts
// src/rbac/policies.ts
import { Policy, Scope } from '@kyrobit/rbac'
import type { ResourceDefinition } from '@kyrobit/rbac'

export const resources: ResourceDefinition[] = [
  {
    type: 'post',
    // table: posts,  // your Drizzle table or Mongoose model (optional):
    //                // enables ownership tracking and query scoping
    policies: [
      new Policy('posts.read'),
      new Policy('posts.create', 'Create posts', ['posts.read']),
      new Policy('posts.update', 'Update posts', ['posts.read'], [Scope.owned()]),
      new Policy('posts.delete', 'Delete posts', ['posts.read'], [Scope.owned()]),
    ],
  },
  {
    type: 'comment',
    policies: [
      new Policy('comments.read'),
      new Policy('comments.moderate', 'Moderate comments', ['comments.read']),
    ],
  },
]
```

Export the array as `resources`. Point [`rbac.config.ts`](/reference/configuration) at this file. Run `npx rbac sync` to push it to the database.

`type` names the resource for scoped checks and ownership. `table` is optional. Set it to enable ownership tracking ([Ownership](/guide/ownership)).

## Next steps

- [Groups](/guide/groups) — bundle policies into roles
- [Sync](/guide/sync) — push policies to the database
- [Protecting routes](/guide/protecting-routes) — check policies in your app
