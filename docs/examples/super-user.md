# Example: Super User

What happens when an admin accidentally removes all policy groups, or locks themselves out? A `is_super` account can always get in — no policy check runs, no scope is evaluated.

---

## Setup

Add an `isSuperAdmin` column to your users table:

```ts
// src/db/schema/user.ts
export const users = pgTable('users', {
  id:           text('id').primaryKey(),
  email:        text('email').notNull().unique(),
  isSuperAdmin: boolean('is_super_admin').notNull().default(false),
})
```

Return it from the `forPortal` callback:

```ts
const rbac = app.rbac.forPortal('admin', async (req) => ({
  id:       req.user.id,
  is_super: req.user.isSuperAdmin,
}))
```

---

## Seed the super user account

```ts
// src/db/seeders/admin.ts
await db.untracked
  .insert(users)
  .values({
    id:           'superadmin',
    email:        'admin@yourapp.com',
    isSuperAdmin: true,
  })
  .onConflictDoUpdate({
    target: users.id,
    set:    { isSuperAdmin: true },
  })
```

---

## What is_super bypasses

When `is_super` is `true`, `requirePolicy` returns immediately. No database query, no cache lookup, no scope check. The handler always runs, regardless of which policies the user has.

---

## Protect the super user account

Make sure other admins can't delete or demote the super user:

```ts
app.delete('/users/:id', {
  preHandler: adminRbac.requirePolicy('user.delete'),
}, async (req, reply) => {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, req.params.id))
    .limit(1)

  if (!user) return reply.status(404).send({ message: 'Not found' })

  if (user.isSuperAdmin) {
    return reply.status(403).send({ message: 'Cannot delete a super user account' })
  }

  await db.delete(users).where(eq(users.id, req.params.id))
  return { ok: true }
})
```

---

## Emergency recovery

Policies were accidentally deleted, admin groups are empty, everyone is locked out:

```bash
# 1. Log in with the super user account — is_super bypasses all checks
# 2. Restore policies and groups from your code:
bunx --bun rbac sync
# 3. Regular admins can log in again
```

The super user doesn't need any policies assigned. `is_super` bypasses everything — the user just needs to exist in the database with `isSuperAdmin: true`.
