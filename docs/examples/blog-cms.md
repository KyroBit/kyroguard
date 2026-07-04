# Example: Blog CMS

A content management system with posts and comments. Four roles: viewer (read-only), author (own posts only), editor (any post), and admin (everything). One scope — `own-post` — restricts authors to posts they created.

---

## File structure

```
src/rbac/
  policies.ts
  scopes.ts
  groups.ts
rbac.config.ts
```

---

## Policies

```ts
// src/rbac/policies.ts
import { Policy, type ResourceDefinition } from '@kyrobit/rbac'
import { posts }        from '@/db/schema/post.js'
import { comments }     from '@/db/schema/comment.js'
import { ownPostScope } from './scopes.js'

export const resources: ResourceDefinition[] = [
  {
    table:  posts,
    type:   'post',
    policies: [
      new Policy('post.read'),
      new Policy('post.create', 'Create Post',  ['post.read']),
      new Policy('post.update', 'Update Post',  ['post.read'], [ownPostScope]),
      new Policy('post.delete', 'Delete Post',  ['post.read'], [ownPostScope]),
    ],
  },
  {
    table: comments,
    type:  'comment',
    policies: [
      new Policy('comment.read'),
      new Policy('comment.create', 'Create Comment', ['comment.read']),
      new Policy('comment.delete', 'Delete Comment', ['comment.read']),
    ],
  },
]
```

The fourth argument (`scopeOptions`) on `post.update` and `post.delete` declares `own-post` as a valid scope choice for those policies. Authors get the scope restriction; editors and admins get `null` (unrestricted).

---

## Scope

```ts
// src/rbac/scopes.ts
import { Scope, resourceOwners } from '@kyrobit/rbac'
import { eq, and }               from 'drizzle-orm'

export const ownPostScope = new Scope('own-post', 'Own Post',
  async (subject, resource, db) => {
    const rows = await db
      .select({ id: resourceOwners.id })
      .from(resourceOwners)
      .where(and(
        eq(resourceOwners.resource_type, resource.type),
        eq(resourceOwners.resource_id,   resource.id),
        eq(resourceOwners.owner_id,      subject.id),
      ))
      .limit(1)
    return rows.length > 0
  }
)
```

The library populates `rbac_resource_owners` automatically on every insert through `db`. The scope function just checks whether the record belongs to the requesting user.

---

## Groups

```ts
// src/rbac/groups.ts
export const groups = {
  viewer: {
    label:    'Viewer',
    policies: ['post.read', 'comment.read'],
  },
  author: {
    label: 'Author',
    policies: {
      'post.read':      null,
      'post.create':    null,
      'post.update':    'own-post',   // only posts they wrote
      'post.delete':    'own-post',   // only posts they wrote
      'comment.read':   null,
      'comment.create': null,
    },
  },
  editor: {
    label: 'Editor',
    policies: {
      'post.read':      null,
      'post.create':    null,
      'post.update':    null,   // can update any post
      'comment.read':   null,
      'comment.create': null,
      'comment.delete': null,
    },
  },
  admin: {
    label:    'Admin',
    policies: 'all',
  },
}
```

`null` means the policy is granted without restriction. A scope string means the scope check must pass before the action proceeds.

---

## Config

```ts
// rbac.config.ts
export default {
  policies: './src/rbac/policies.ts',
  groups:   './src/rbac/groups.ts',
}
```

```bash
bunx rbac sync
```

---

## DB setup

Wrap your database so ownership is recorded on every insert:

```ts
// src/db/index.ts
import { createTrackedDb } from '@kyrobit/rbac'
import { resources } from '@/rbac/policies.js'

export const db = createTrackedDb(rawDb, { resources })
// db.insert(...)           → ownership recorded
// db.untracked.insert(...) → no ownership entry
```

---

## Plugin registration

```ts
// src/plugins/rbac.ts
import { rbacPlugin, createDrizzleAdapter } from '@kyrobit/rbac'
import { db } from '@/db/index.js'

await app.register(rbacPlugin, {
  adapter: createDrizzleAdapter(db.untracked),
  db,
})

const rbac = app.rbac.forPortal('cms', (req) => ({ id: req.user.id }))
```

---

## Routes

```ts
// src/routes/posts.ts
import { eq } from 'drizzle-orm'
import { posts } from '@/db/schema/post.js'

app.get('/posts', {
  preHandler: rbac.requirePolicy('post.read'),
}, async () => db.select().from(posts))

app.post('/posts', {
  preHandler: rbac.requirePolicy('post.create'),
}, async (req) => {
  const [post] = await db   // ownership is recorded automatically
    .insert(posts)
    .values({ ...req.body, authorId: req.user.id })
    .returning()
  return post
})

app.put('/posts/:id', {
  preHandler: rbac.requirePolicy('post.update', {
    resource: (req) => ({ type: 'post', id: req.params.id }),
  }),
}, async (req) => {
  const [post] = await db
    .update(posts).set(req.body)
    .where(eq(posts.id, req.params.id))
    .returning()
  return post
})

app.delete('/posts/:id', {
  preHandler: rbac.requirePolicy('post.delete', {
    resource: (req) => ({ type: 'post', id: req.params.id }),
  }),
}, async (req) => {
  await db.delete(posts).where(eq(posts.id, req.params.id))
  return { ok: true }
})
```

---

## Comments routes

```ts
// src/routes/comments.ts
app.get('/posts/:postId/comments', {
  preHandler: rbac.requirePolicy('comment.read'),
}, async (req) =>
  db.select().from(comments).where(eq(comments.postId, req.params.postId))
)

app.post('/posts/:postId/comments', {
  preHandler: rbac.requirePolicy('comment.create'),
}, async (req) => {
  const [comment] = await db
    .insert(comments)
    .values({ ...req.body, postId: req.params.postId, authorId: req.user.id })
    .returning()
  return comment
})

app.delete('/comments/:id', {
  preHandler: rbac.requirePolicy('comment.delete'),
}, async (req) => {
  await db.delete(comments).where(eq(comments.id, req.params.id))
  return { ok: true }
})
```

---

## Assigning users

```ts
import { assignGroup, removeGroup } from '@kyrobit/rbac'

// New users start as viewers
await rbac.assignGroup(userId, 'viewer')

// Promote to author — remove viewer first for a clean transition
await rbac.removeGroup(userId, 'viewer')
await rbac.assignGroup(userId, 'author')
app.rbac.clearPolicyCache(userId)
```

---

## How it plays out at request time

```
PUT /posts/42   (user: author, post 42 is theirs)
  → policy: post.update, scope: 'own-post'
  → ownPostScope.check({ id: userId }, { type: 'post', id: '42' })
  → SELECT WHERE resource_id = '42' AND owner_id = userId → found → 200 OK

PUT /posts/99   (user: author, post 99 belongs to someone else)
  → same scope check
  → SELECT WHERE resource_id = '99' AND owner_id = userId → not found → 403 Forbidden

PUT /posts/99   (user: editor, scope: null)
  → scope is null → check skipped → 200 OK
```

---

**Next:** [Multi-portal — admin + branch](./multi-portal)
