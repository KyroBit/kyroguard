# Defining policies

A policy is one named permission — `posts.create`, `comments.moderate` — that a guard checks at request time. On this page you write a `policies.ts` file with the `Policy` class, attach the policies to the resources they protect with `ResourceDefinition`, and register the file so `rbac sync` can push it to storage.

::: tip Prerequisites
You need a project with `@kyrobit/rbac` installed and an `rbac.config.ts` (created by `rbac init`) — see [Installation](/guide/installation).
:::

## Naming policies

Policy names follow the `resource.action` convention: lowercase, dot-separated, the resource first.

```
posts.view    posts.create    posts.update    comments.moderate
```

Names in your code are **unqualified** — you never write the portal prefix. When you sync the file under a portal named `admin`, the stored name becomes `admin.posts.view`, and a guard created from the `admin` portal checks that same qualified name. Exactly one layer (the engine) adds the prefix; this means the same policies file can serve two portals without name collisions, and app code never concatenates portal strings by hand.

## Writing the policies file

### 1. Create `src/rbac/policies.ts`

The file exports a `ResourceDefinition[]` named `resources` (the loader also accepts `policies` or a default export). This is a complete example for a blog backend:

```ts
// src/rbac/policies.ts
import { Policy, Scope } from '@kyrobit/rbac'
import type { ResourceDefinition } from '@kyrobit/rbac'
import { posts, comments } from '../db/schema.js'

const owned = Scope.owned()

export const resources: ResourceDefinition[] = [
  {
    type: 'post',
    table: posts, // optional — enables ownership auto-tracking and query scoping
    policies: [
      new Policy('posts.view'),
      new Policy('posts.create', 'Create posts', ['posts.view']),
      new Policy('posts.update', 'Update posts', ['posts.view'], [owned]),
      new Policy('posts.delete', 'Delete posts', ['posts.view'], [owned]),
      new Policy('posts.publish', 'Publish posts', ['posts.update']),
    ],
  },
  {
    type: 'comment',
    table: comments,
    policies: [
      new Policy('comments.view'),
      new Policy('comments.moderate', 'Moderate comments', ['comments.view']),
    ],
  },
]
```

### 2. Point `rbac.config.ts` at the file

Each entry in `portals` names one portal and the module that defines its policies:

```ts
// rbac.config.ts
import { defineConfig } from '@kyrobit/rbac'

export default defineConfig({
  adapter: async () => {
    const { drizzleAdapter } = await import('@kyrobit/rbac/drizzle')
    const schema = await import('./src/db/rbac-schema.js')
    const { db } = await import('./src/db/index.js')
    return drizzleAdapter(db, { schema })
  },
  portals: [
    {
      name: 'admin',
      policies: './src/rbac/policies.ts',
      groups: './src/rbac/groups.ts',
    },
  ],
  typegen: { output: './rbac.d.ts' },
})
```

### 3. Sync

```sh
npx rbac sync
```

This upserts the seven policies as `admin.posts.view` … `admin.comments.moderate` and regenerates `rbac.d.ts`, so `requirePolicy('posts.view')` autocompletes and a typo fails the type check. The full pipeline is on [Syncing policies](/guide/syncing-policies).

## The `Policy` constructor

```ts
new Policy(name, label?, dependsOn?, scopeOptions?)
```

| Parameter | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | Unqualified `resource.action` name. |
| `label` | `string?` | Display name for admin UIs. Defaults to the last name segment with hyphens turned into spaces: `posts.publish-now` → `publish now`. |
| `dependsOn` | `string[]?` | Other policy names in the same portal that this one requires. |
| `scopeOptions` | `Scope[]?` | Named row-level checks a grant of this policy may carry. |

## Declaring dependencies with `dependsOn`

`posts.create` lists `['posts.view']` because a user who can create posts must also see them. Dependencies resolve **at sync time, not at request time** — a guard checks exactly one policy against one storage lookup, so the request hot path never walks a graph. During `rbac sync`:

1. Every `dependsOn` entry is validated against the portal's policy list. An unknown name — a typo like `['posts.veiw']` — aborts the sync before anything is written:

   ```
   [rbac] Policy "posts.create" depends on "posts.veiw" which is not defined.
   ```

2. Every stored group is back-filled: if a group holds `posts.publish`, sync walks the chain (`posts.publish` → `posts.update` → `posts.view`) and adds the missing policies to the group as unrestricted grants. Existing entries keep their scopes; the fill is additive and idempotent.

So granting `posts.create` to a group fills `posts.view` into that group on the next sync — a role can never hold an action while missing what the action depends on.

::: warning Groups seeded from `groups.ts` need explicit dependencies
Dependency back-fill runs before group seeding, and seeding replaces a seeded group's entries with exactly its seed list. A back-filled dependency therefore does not survive in a group defined in `groups.ts` — list dependencies explicitly there (or use `policies: 'all'`). Back-fill covers groups managed at runtime, such as roles an admin UI edits. See [Re-seeding replaces a group's grants](/guide/organizing-groups#what-re-seeding-does).
:::

## Restricting grants with `scopeOptions`

`scopeOptions` declares which named row-level checks a grant of this policy can carry. `Scope.owned()` is the built-in ownership check; it works on every storage backend. A grant stores only the scope **name** (for example `'owned'`); at guard time the engine looks the name up in the registry collected from your `resources` and runs its check against the resolved resource.

If the stored name matches no registered scope, or the guard has no resource resolver, the request is denied with `RBAC_SCOPE_DENIED` — never allowed. A restriction that cannot be evaluated must fail closed, otherwise deleting a scope from code would silently widen access.

## Linking a table with `ResourceDefinition`

```ts
interface ResourceDefinition {
  type: string          // resource type name, used in ownership records
  policies: Policy[]
  table?: unknown       // Drizzle table or Mongoose model
  context?: Record<string, ContextPolicies> // query-scoping config
}
```

`table` is optional. Storage-level features — ownership auto-tracking through the tracked db and automatic query scoping — need it; guard-only usage does not, so a service that only checks policies can omit every `table` and never import its ORM schema here.

## What a denied check returns

A guard that checks a policy the subject does not hold responds with status 403 and the stable code `RBAC_POLICY_DENIED`:

::: code-group

```json [Fastify (default error handler)]
{
  "statusCode": 403,
  "code": "RBAC_POLICY_DENIED",
  "error": "Forbidden",
  "message": "Forbidden"
}
```

```json [Express (errorHandler())]
{
  "message": "Forbidden",
  "code": "RBAC_POLICY_DENIED"
}
```

:::

Every code is listed in the [error reference](/reference/errors).

## Next steps

- [Organizing groups](/guide/organizing-groups) — bundle these policies into assignable roles.
- [Syncing policies](/guide/syncing-policies) — what `rbac sync` does with this file, step by step.
- [Error reference](/reference/errors) — every `RBAC_*` code and its status.
