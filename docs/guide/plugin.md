# Plugin Setup

## DB setup (apps that use scopes)

If your app uses [Scopes](./scopes), wrap your database instance with `createTrackedDb` before passing it anywhere. This enables automatic ownership recording — every insert through `db` silently writes to `rbac_resource_owners` so your scope functions can query it later:

```ts
// src/db/index.ts
import { createTrackedDb } from '@kyrobit/rbac'
import { resources } from '@/rbac/policies.js'

export const db = createTrackedDb(rawDb, { resources })
// db.insert(...)           → ownership recorded automatically
// db.untracked.insert(...) → skip tracking (migrations, seeders, background jobs)
```

If you're not using scopes, skip this step and use your database instance directly.

---

## Register the plugin

Register once when your Fastify app starts:

```ts
// src/plugins/rbac.ts
import { rbacPlugin, createDrizzleAdapter } from '@kyrobit/rbac'
import { db } from '@/db/index.js'

await app.register(rbacPlugin, {
  adapter: createDrizzleAdapter(db.untracked ?? db),
  db,
})
```

Pass `db` (the tracked instance from `createTrackedDb`) so the plugin can call scope check functions and auto-discover all scopes. Pass `db.untracked` to the adapter so internal library queries bypass the ownership proxy.

If you're not using scopes, omit `db` entirely:

```ts
await app.register(rbacPlugin, {
  adapter: createDrizzleAdapter(db),
})
```

---

## Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `adapter` | `RbacAdapter` | Yes | Database adapter. Use `createDrizzleAdapter(db)`. |
| `db` | `TrackedDb` | No | The tracked db from `createTrackedDb`. Required if any policy uses scope checks — scopes are discovered automatically from it. |

---

## app.rbac

After registration, `app.rbac` is available throughout the Fastify instance:

| Method | Description |
|--------|-------------|
| `forPortal(portal, fn)` | Registers a subject resolver for a portal and returns a typed `PortalInstance`. See [Identifying the Current User](./subject). |
| `clearPolicyCache(userId?)` | Clears the in-memory policy cache for one user or all users. Call this after any assignment change. See [Cache](./cache). |

---

**Next:** [Identifying the Current User](./subject)
