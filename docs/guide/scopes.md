# Scopes

Scopes answer one question: this user may update posts, but which posts?

```ts
import { Policy, Scope } from '@kyrobit/rbac'

export const resources = [
  {
    type: 'post',
    policies: [
      new Policy('posts.read'),
      // Policy(name, label, dependsOn, allowed scopes)
      new Policy('posts.update', 'Update posts', [], [Scope.owned()]),
    ],
  },
]
```

A policy lists the scopes it can be granted with. `Scope.owned()` is the built-in one. It passes when the user created the row. It works on every database. [Ownership](/guide/ownership) explains how rows get owners.

## Granting a scoped policy

```ts
export const groups = {
  author: {
    label: 'Author',
    policies: {
      'posts.read': null,
      'posts.update': 'owned',
    },
  },
}
```

Each value is a scope name, or `null` for no scope. `null` covers every post. So authors read every post but update only their own. Groups are covered in [Groups](/guide/groups).

Direct grants take a scope the same way. `admin` is a portal — see [Portals](/guide/portals):

```ts
await admin.assignPolicy(user.id, 'posts.update', { scope: 'owned' })
```

## Guarding a route

A scoped check needs to know which row is being touched. Give the guard a `resource` resolver. Fastify shown; in Express the guard is plain middleware:

```ts
app.patch(
  '/posts/:id',
  {
    preHandler: admin.requirePolicy('posts.update', {
      resource: req => ({ type: 'post', id: (req.params as { id: string }).id }),
    }),
  },
  updatePost,
)
```

The guard reads the user's grant first. An unscoped grant passes immediately. A scoped grant runs the resolver, then the scope check decides. Guards are covered in [Protecting routes](/guide/protecting-routes).

## Writing your own scope

A scope is a name, a label and a check. Return `true` to allow. Here is a scope that allows posts from the user's own branch:

```ts
import { Scope } from '@kyrobit/rbac'
import { eq } from 'drizzle-orm'
import { db } from './db'
import { posts } from './schema'

export const sameBranch = new Scope(
  'same-branch',
  'Same branch',
  async (user, resource) => {
    const [post] = await db
      .select()
      .from(posts)
      .where(eq(posts.id, resource.id))
    // context_id is whatever your getSubject resolver put there
    return post?.branchId === user.context_id
  },
)
```

Register it on the policies that accept it:

```ts
new Policy('posts.update', 'Update posts', [], [Scope.owned(), sameBranch])
```

Now a grant can name `'owned'` or `'same-branch'`. The check runs against the resource the guard resolved.

## What a denied request gets

A failed scope check returns 403. A resource the resolver cannot find returns 404.
