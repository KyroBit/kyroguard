# Assigning access

Give a user a role through the portal:

```ts
await admin.assignGroup(user.id, 'editor')
```

Groups are roles. This makes the user an editor on the `admin` portal. Most apps only need `assignGroup` and `assignPolicy` on a portal.

```ts
// a single policy instead of a role
await admin.assignPolicy(user.id, 'posts.publish')

// scoped: only rows the user owns
await admin.assignPolicy(user.id, 'posts.edit', { scope: 'owned' })

// per tenant
await admin.assignGroup(user.id, 'manager', { contextId: 'branch-1' })
```

Policy names stay short. The portal adds its own prefix. Groups and policies must exist before you assign them. See [Groups](/guide/groups) and [Syncing policies](/guide/sync).

Removal mirrors assignment:

```ts
await admin.removeGroup(user.id, 'editor')
await admin.removePolicy(user.id, 'posts.publish')
```

Assigning twice is safe. The second call does nothing.

Changes apply immediately on this server. Running several servers? See [Production](/guide/production).

## Scripts and admin panels

Outside a request handler there is often no portal instance. Use `rbac.admin.*` there:

```ts
import { rbac } from './rbac.js'

await rbac.admin.assignGroup(
  { subjectId: 'user-42', portal: 'admin' },
  'editor',
)

await rbac.admin.assignPolicy(
  { subjectId: 'user-42', portal: 'admin', contextId: 'branch-1' },
  'admin.posts.read',
)
```

Same operations, made explicit. `rbac.admin` takes full policy names like `admin.posts.read`. Portal instances add the prefix for you. This API does not.

## Super users

```ts
const admin = app.rbac.portal('admin', {
  getSubject: async req => {
    const user = await getUser(req)
    return user ? { id: user.id, is_super: user.isSuper } : null
  },
})
```

Return `is_super: true` and the user passes every policy check. Reserve it for a handful of trusted accounts. To turn the bypass off entirely, pass `superBypass: false` to `createRbac()`.
