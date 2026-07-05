# Resolving the subject

Every portal owns one `getSubject` function that turns an incoming request into the authenticated principal — the subject — that guards authorize. You implement the contract, shape the subject for tenancy and scope checks, and wire it to JWT or session auth.

::: tip Prerequisites
You need a portal on a running app — see [Setting up Fastify](/guide/setting-up-fastify) or [Setting up Express](/guide/setting-up-express).
:::

## 1. Implement getSubject

```ts
const admin = app.rbac.portal('admin', {
  getSubject: async request => {
    // Authenticate here — never authorize. Guards do the authorizing.
    const user = await resolveUserSomehow(request)
    return user ? { id: user.id } : null
  },
})
```

The contract:

- Return a subject object (at minimum `{ id }`) or `null` when the request has no authenticated user.
- `getSubject` is called **lazily at guard time** — when the first `requirePolicy` guard (or `contextHook()`) on the request runs. There is no global authentication hook, so unguarded routes never pay for auth resolution.
- The result is **memoized per request per portal**, `null` included. Stacking several guards from one portal on a route still resolves the subject exactly once — the framework contract test suite asserts one invocation per request.

Why per portal instead of one global hook: an app can host two portals (say `admin` and `customer`) with different token formats. A global hook writes one shared subject slot, so whichever hook ran last would overwrite the other portal's subject for the whole request. Lazy per-portal resolution stores each portal's result under its own key, so two portals on one app can never overwrite each other's subject.

## 2. Return null when there is no user

`null` makes the guard throw `UnauthenticatedError` — status 401, code `RBAC_UNAUTHENTICATED`:

::: code-group

```json [Express (errorHandler)]
{ "message": "Unauthorized", "code": "RBAC_UNAUTHENTICATED" }
```

```json [Fastify (default serializer)]
{
  "statusCode": 401,
  "code": "RBAC_UNAUTHENTICATED",
  "error": "Unauthorized",
  "message": "Unauthorized"
}
```

:::

A subject with an empty `id` (`''`) is refused the same way — the engine never authorizes a subject it cannot identify, because grants, cache keys and ownership rows all key on that id.

## 3. Shape the subject

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` (required) | Stable user or account id. Grants, the policy cache and ownership rows key on it. |
| `context_id` | `string` (optional) | Tenant, branch or organization id. Grants match it by strict equality. |
| `is_super` | `boolean` (optional) | `true` bypasses all policy checks (enabled by default; disable with `superBypass: false` in `createRbac`). Reserve for break-glass accounts. |
| any other field | `unknown` | Carried through to scope checks unchanged. |

Do not set `portal` — the portal adds its own name to the subject it stores. That is what keeps a grant issued in one portal from ever satisfying a route in another.

`portal` and `context_id` are matched by strict equality: a grant issued with `contextId: 'branch-1'` matches only requests whose subject carries `context_id: 'branch-1'` — not `branch-2`, and not a subject with no context at all (and a grant with no context never applies to a request that has one). This is what keeps tenant data isolated; there is no fallback from "no match" to "global grant".

Extra fields are how custom scopes see your domain data:

```ts
getSubject: async req => {
  const user = await users.findBySession(req)
  if (!user) return null
  return {
    id: user.id,
    context_id: user.branchId,
    is_super: user.role === 'root',
    team_id: user.teamId, // readable as subject.team_id inside Scope checks
  }
}
```

A scope check receives the full subject, so `team_id` above is available to a custom `Scope` such as `new Scope('same-team', 'Same team', (subject, resource, ctx) => ...)` — see [Scopes](/guide/writing-scopes).

## Wiring JWT auth

::: code-group

```ts [Fastify (@fastify/jwt)]
import fastifyJwt from '@fastify/jwt'

await app.register(fastifyJwt, { secret: process.env.JWT_SECRET! })

const admin = app.rbac.portal('admin', {
  getSubject: async request => {
    try {
      const payload = await request.jwtVerify<{ sub: string; org?: string }>()
      return { id: payload.sub, context_id: payload.org }
    } catch {
      return null // missing/invalid token → uniform 401 RBAC_UNAUTHENTICATED
    }
  },
})
```

```ts [Express (jsonwebtoken)]
import jwt from 'jsonwebtoken'

const admin = portal('admin', {
  getSubject: req => {
    const token = req.header('authorization')?.replace(/^Bearer /, '')
    if (!token) return null
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as {
        sub: string
        org?: string
      }
      return { id: payload.sub, context_id: payload.org }
    } catch {
      return null // expired/invalid token → uniform 401 RBAC_UNAUTHENTICATED
    }
  },
})
```

:::

## Wiring session auth

::: code-group

```ts [Fastify (@fastify/secure-session)]
import secureSession from '@fastify/secure-session'

await app.register(secureSession, {
  key: Buffer.from(process.env.SESSION_KEY!, 'hex'),
})

const admin = app.rbac.portal('admin', {
  getSubject: async request => {
    const userId = request.session.get('userId')
    if (!userId) return null
    const user = await users.findById(userId)
    return user ? { id: user.id, context_id: user.orgId } : null
  },
})
```

```ts [Express (express-session)]
import session from 'express-session'

app.use(
  session({
    secret: process.env.SESSION_SECRET!,
    resave: false,
    saveUninitialized: false,
  }),
)
app.use(context()) // session and context() both run before any guard

const admin = portal('admin', {
  getSubject: async req => {
    const userId = req.session.userId // augment SessionData with your fields
    if (!userId) return null
    const user = await users.findById(userId)
    return user ? { id: user.id, context_id: user.orgId } : null
  },
})
```

:::

::: warning Return null for "not authenticated" — throw for real failures
Catch token-verification errors and return `null`, so every unauthenticated client gets the same `RBAC_UNAUTHENTICATED` body; a throw from `getSubject` bypasses that mapping and surfaces the raw error through the framework pipeline instead (for example `@fastify/jwt`'s own error shape). The reverse also matters: `null` is memoized for the rest of the request, so returning `null` on an infrastructure failure (user database down) silently converts a 500-class outage into 401s — let those errors throw.
:::

## Next steps

- [Protecting routes](/guide/protecting-routes) — attach guards and read the full decision table.
- [Setting up Fastify](/guide/setting-up-fastify) or [Setting up Express](/guide/setting-up-express) — where the portal and error pipeline are wired.
- [Error reference](/reference/errors) — every `RBAC_*` code in one place.
