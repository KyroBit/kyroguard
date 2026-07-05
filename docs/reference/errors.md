# Errors

Every denial is a typed error with a stable, machine-readable `code`. This page lists each `RBAC_*` code with its HTTP status, exact response body, the precise engine condition that raises it, common causes and fixes.

## How errors surface

The core never writes HTTP responses. `engine.authorize()` either resolves (allow) or throws a subclass of `RbacError`; each framework integration hands the error to the framework's own error pipeline:

- **Fastify** — guards throw. Fastify's default error handling serializes the error (it carries `statusCode` and `code`), and `onSend` hooks and CORS headers keep running. Override the body per plugin instance with `rbacFastify(rbac, { formatError })`.
- **Express** — guards call `next(err)`; `rbacExpress(rbac).errorHandler()` terminates the chain, sending `error.statusCode` with `error.toBody()` (or your `formatError` result). Non-`RbacError` values are delegated to the next error handler.

`RbacError` is exported from `@kyrobit/rbac` for `instanceof` checks, along with each subclass and the `RbacErrorCode` union:

```ts
import {
  RbacError,
  UnauthenticatedError,
  PolicyDeniedError,
  ScopeDeniedError,
  ResourceNotFoundError,
  MisconfiguredError,
} from '@kyrobit/rbac'
import type { RbacErrorCode } from '@kyrobit/rbac'
```

`error.toBody()` returns `{ message, code }` — the default JSON body shown below for each code. Fastify's default serializer wraps the same fields with `statusCode` and the HTTP status phrase, for example:

```json
{
  "statusCode": 403,
  "code": "RBAC_POLICY_DENIED",
  "error": "Forbidden",
  "message": "Forbidden"
}
```

::: warning Branch on `code`, never on status or message
Two different denials share status 403 (`RBAC_POLICY_DENIED` and `RBAC_SCOPE_DENIED`), and messages are deliberately generic so responses do not leak what exists. The `code` field is the stable contract.
:::

## Summary

| Code | Status | Class | Fires when |
| --- | --- | --- | --- |
| `RBAC_UNAUTHENTICATED` | 401 | `UnauthenticatedError` | No subject, or subject id is empty |
| `RBAC_POLICY_DENIED` | 403 | `PolicyDeniedError` | Policy not granted for this subject + portal + context |
| `RBAC_SCOPE_DENIED` | 403 | `ScopeDeniedError` | Scoped grant: scope unresolvable, or the scope check returned false |
| `RBAC_RESOURCE_NOT_FOUND` | 404 | `ResourceNotFoundError` | Scoped grant: the resource resolver returned nothing |
| `RBAC_MISCONFIGURED` | 500 | `MisconfiguredError` | Library wired incorrectly (developer error, not a request outcome) |

## RBAC_UNAUTHENTICATED

**Status 401.** Default body:

```json
{ "message": "Unauthorized", "code": "RBAC_UNAUTHENTICATED" }
```

**Engine condition.** The first check in `authorize()`: the subject is `null`/`undefined`, or its `id` is the empty string. Nothing else runs — no cache lookup, no storage query.

**Common causes**

- Your portal's `getSubject` returned `null` (no session, expired token) — this is the designed path for unauthenticated requests.
- `getSubject` returned a subject object whose `id` is `''` or missing.
- The guard runs before your authentication middleware populated whatever `getSubject` reads.

**Fix.** Return `null` from `getSubject` when there is no authenticated user, and a subject with a non-empty `id` otherwise. See [Resolving the subject](/guide/resolving-the-subject).

## RBAC_POLICY_DENIED

**Status 403.** Default body:

```json
{ "message": "Forbidden", "code": "RBAC_POLICY_DENIED" }
```

**Engine condition.** The subject's resolved policy map — group grants plus direct grants, both matched by **strict equality** on `(subjectId, portal, contextId)` — contains no entry for the qualified policy name. The thrown `PolicyDeniedError` carries the qualified name on its `policy` property (not included in the default body).

**Common causes**

- The grant was never made, or was made in a **different portal or context**. Portal and context are matched by strict equality — a grant with no context never applies to a request with one, and a grant in the `customer` portal never satisfies an `admin` route; this is what keeps tenant data isolated. There is no fallback in either direction.
- The subject's group has `isActive = false` — grants from inactive groups are excluded (direct grants are unaffected).
- The policy was renamed or removed and `rbac sync` deleted the old row; deletion cascades to group entries and direct assignments, so old grants disappear with it.
- The guard checks a name the portal qualifies differently than you expect: `requirePolicy('posts.read')` on portal `admin` checks the stored grant `admin.posts.read`.

**Fix.** Grant the policy at the exact coordinates the request authenticates with — `portal.assignPolicy('user-1', 'posts.read', { contextId: 'branch-1' })` for a request in `branch-1` — or assign a group holding it. Use the `onDecision` hook to log the qualified policy, portal and context the engine actually compared.

## RBAC_SCOPE_DENIED

**Status 403.** Default body:

```json
{ "message": "Forbidden", "code": "RBAC_SCOPE_DENIED" }
```

**Engine condition.** The policy **is** granted, but the grant carries a scope name, and one of two things happened, in this order:

1. The scope name is not in the registry (no synced policy lists it in `scopeOptions`), **or** the guard has no `resource` resolver. A scoped grant with missing wiring is always a deny, never a bypass — treating it as unrestricted would widen access on a wiring mistake.
2. The resource resolved, and the scope's `check(subject, resource, ctx)` returned `false`.

The thrown `ScopeDeniedError` carries `policy` and `scope` properties.

**Common causes**

- The route lacks `requirePolicy('posts.update', { resource: req => ... })` even though the subject's grant is scoped.
- `createRbac` was called without `resources`, so `collectScopes` produced an empty registry and no scope name resolves.
- The subject genuinely fails the check — for `Scope.owned()`, no ownership row matches `(subject.id, resource.type, resource.id)`, often because the resource was created before ownership tracking was wired up.

**Fix.** Pass a resource resolver on every route whose policy can be granted with a scope; pass your `resources` to `createRbac`; verify ownership rows with `rbac.ownership.isOwner(subjectId, { type, id })`. See [Writing scopes](/guide/writing-scopes) and [Tracking ownership](/guide/tracking-ownership).

## RBAC_RESOURCE_NOT_FOUND

**Status 404.** Default body:

```json
{ "message": "Not found", "code": "RBAC_RESOURCE_NOT_FOUND" }
```

**Engine condition.** The grant is scoped, the scope and resolver both exist, and the resolver returned `null` or `undefined`.

**Why 404 and not 403.** Your resolver looked the row up and found nothing — the target does not exist for this request, and the response matches what any read of that id would return. The scope check never runs on a row that could not be resolved.

**Common causes**

- The request targets a deleted or never-existing id.
- The resolver reads the wrong request parameter, or queries the wrong table, and returns `null` for rows that do exist.

**Fix.** Verify the resolver against a known-good id. Note the resolver is only called for scoped grants — an unrestricted grant never triggers it, so a resolver bug can hide until the first scoped user arrives.

## RBAC_MISCONFIGURED

**Status 500.** Default body (Express `errorHandler()`):

```json
{ "message": "[rbac] No request context for portal \"admin\" — register rbacExpress(rbac).context() before its guards.", "code": "RBAC_MISCONFIGURED" }
```

**Condition.** Unlike the four codes above, this is thrown by the framework layers and `trackedDb`, not by the engine's decision procedure. It means the library is wired incorrectly — a developer error, not a request outcome:

- **Fastify:** a guard ran but the per-request context is missing — `rbacFastify()` was not registered on the Fastify instance handling this request. Message: `rbac request context is missing — register rbacFastify() on this Fastify instance before handling requests`.
- **Express:** a portal guard ran before the context middleware. Message: `[rbac] No request context for portal "admin" — register rbacExpress(rbac).context() before its guards.` Also thrown when a guard's promise rejects with a falsy value (`[rbac] Guard rejected without an error value`) — a falsy rejection must never fall through as a successful `next()`, because that would authorize the request.
- **Drizzle `trackedDb`** with `strictTracking: 'error'`: an insert on a registered resource yielded no trackable ids.

**Fix.** Register `rbacFastify(rbac)` before routes, or `rbacExpress(rbac).context()` before any portal guard. This code appearing in production monitoring indicates a deploy-time wiring regression, not user behavior.

## UnknownPolicyError

Not an HTTP error — `UnknownPolicyError` extends `Error` (not `RbacError`), has no `statusCode`, and is thrown from **assignment** calls, not guards:

```
[rbac] Policy "admin.posts.read" not found — run `rbac sync` first.
```

**Condition.** `assignPolicy` (via `rbac.admin.assignPolicy` or a portal's `assignPolicy`) looked up the fully-qualified policy name in storage and found no row (S12). Assignments reference stored policies, so sync must have run first.

**Common causes**

- `rbac sync` has not run since the policy was added.
- The name is mis-qualified: `rbac.admin.assignPolicy` takes **fully-qualified** names (`admin.posts.read`), while portal instances take unqualified names (`posts.read`) and qualify them for you.

**Fix.** Run `rbac sync`; prefer the portal assignment methods in application code so qualification cannot drift. Catch it where you expose assignment endpoints:

```ts
import { UnknownPolicyError } from '@kyrobit/rbac'

try {
  await admin.assignPolicy(userId, policyName)
} catch (error) {
  if (error instanceof UnknownPolicyError) {
    // 422: the policy name does not exist in storage
  } else {
    throw error
  }
}
```

## Next steps

- [Protecting routes](/guide/protecting-routes) — the full decision table every guard walks.
- [Observability](/guide/observability) — the `onDecision` hook that reports which condition fired.
- [CLI](/reference/cli) — `rbac sync`, which most `UnknownPolicyError` fixes end with.
