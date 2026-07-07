# Errors

Every denial is a typed error with a stable `code`.

```ts
import {
  KyroguardError,
  UnauthenticatedError,
  PolicyDeniedError,
  ScopeDeniedError,
  ResourceNotFoundError,
  MisconfiguredError,
} from '@kyrobit/kyroguard'
```

Guards throw these errors. Express sends the bodies below from `kyroguardExpress(guard).errorHandler()`. Fastify serializes the same `code` and status through its standard error shape. Both integrations accept a `formatError` option to change the body.

| Code | Status | Class | `reason` |
| --- | --- | --- | --- |
| `UNAUTHENTICATED` | 401 | `UnauthenticatedError` | — |
| `ACCESS_DENIED` | 403 | `PolicyDeniedError` | `'policy'` |
| `ACCESS_DENIED` | 403 | `ScopeDeniedError` | `'scope'` |
| `NOT_FOUND` | 404 | `ResourceNotFoundError` | — |
| `MISCONFIGURED` | 500 | `MisconfiguredError` | — |

::: warning Branch on `code`, not status or message
Messages are deliberately generic. The `code` field is the stable contract; for `ACCESS_DENIED`, the `reason` field says which kind of denial it was.
:::

## UNAUTHENTICATED

**Status 401.**

```json
{ "message": "Unauthorized", "code": "UNAUTHENTICATED" }
```

**When.** Your `getSubject` returned no user, or a user without an id. This is the normal path for requests with no session.

**Fix.** Return `null` from `getSubject` when nobody is logged in, and a user with a non-empty `id` otherwise. Check that the guard runs after your authentication middleware. See [Multi-tenancy](/guide/multi-tenancy).

## ACCESS_DENIED

**Status 403.** One code, two causes. The `reason` field tells them apart, and the two error classes stay distinct — catch `PolicyDeniedError` or `ScopeDeniedError` when you need to branch in code.

```json
{ "message": "Forbidden", "code": "ACCESS_DENIED", "reason": "policy" }
```

::: info Where `reason` appears
`toBody()` includes `reason` on every `ACCESS_DENIED` error, so the Express `errorHandler()` body always carries it. Fastify's default error serializer has a fixed shape — the default Fastify body carries `code: "ACCESS_DENIED"` but **not** `reason`. To expose `reason` on Fastify, use the plugin's `formatError` option (e.g. `body: error.toBody()`) or your own `setErrorHandler`.
:::

### reason: 'policy' (`PolicyDeniedError`)

**When.** The user does not hold this policy in this domain and tenant. Grants are exact: a grant in `school-1` never applies in `school-2`, and a grant in one domain never applies in another.

**Fix.** Grant the policy, or a group that holds it, at the same domain and tenant the request uses. The error's `policy` property carries the full policy name the engine checked. See [Assigning access](/guide/assigning-access).

### reason: 'scope' (`ScopeDeniedError`)

```json
{ "message": "Forbidden", "code": "ACCESS_DENIED", "reason": "scope" }
```

**When.** The policy is granted, but with a scope, and the scope check failed. It also fires when the route has no `resource` resolver, or the scope name is unknown. Missing wiring denies rather than allowing too much.

**Fix.** Add a `resource` resolver to every route whose policy can carry a scope, and pass your `resources` to `createKyroguard`. For `Scope.owned()`, check the ownership rows with `guard.ownership.isOwner()`. See [Scopes](/guide/scopes) and [Ownership](/guide/ownership).

## NOT_FOUND

**Status 404.**

```json
{ "message": "Not found", "code": "NOT_FOUND" }
```

**When.** The grant is scoped and the route's `resource` resolver returned nothing. The target does not exist for this request.

**Fix.** Test the resolver with a known-good id. It only runs for scoped grants, so a resolver bug can hide until the first scoped user hits the route.

## MISCONFIGURED

**Status 500.**

```json
{ "message": "[kyroguard] No request context for domain \"admin\" — register kyroguardExpress(guard).context() before its guards.", "code": "MISCONFIGURED" }
```

**When.** The library is wired incorrectly. A guard ran without the plugin (Fastify) or before the context middleware (Express), or a tracked insert could not be attributed with `strictTracking: 'error'`.

**Fix.** Register `kyroguardFastify(guard)` before your routes, or `kyroguardExpress(guard).context()` before any guard. Seeing this code in production means a wiring regression, not user behavior. See [Protecting routes](/guide/protecting-routes).

## UnknownPolicyError

Not an HTTP error. It is thrown from assignment calls, not guards, and has no `statusCode`.

```
[kyroguard] Policy "admin.reports.view" not found — run `kyroguard sync` first.
```

**When.** `assignPolicy` named a policy that is not in the database. Assignments reference synced policies.

**Fix.** Run `kyroguard sync`. Prefer the domain assignment methods, which add the domain prefix for you. Catch it with `instanceof UnknownPolicyError` where you expose assignment endpoints.

```ts
import { UnknownPolicyError } from '@kyrobit/kyroguard'

try {
  await admin.assignPolicy(userId, policyName)
} catch (error) {
  if (error instanceof UnknownPolicyError) {
    // 422: the policy name does not exist
  } else {
    throw error
  }
}
```

## UnknownScopeError

Not an HTTP error either. Thrown from `assignPolicy` before anything is written.

```
[kyroguard] Scope "granted" is not among the scopeOptions of policy "admin.reports.view" — declare it on the policy and re-sync.
```

**When.** The grant carries a scope the policy does not declare in its `scopeOptions`. `seedGroups` rejects the same mistake at sync time, naming the group and the declared options.

**Fix.** Add the scope to the policy's `scopeOptions` and run `kyroguard sync`, or grant one of the declared scopes. Catch it with `instanceof UnknownScopeError` next to `UnknownPolicyError` where you expose assignment endpoints.
