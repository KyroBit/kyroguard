# Errors

Every denial is a typed error with a stable `code`.

```ts
import {
  GuardError,
  UnauthenticatedError,
  PolicyDeniedError,
  MisconfiguredError,
} from '@kyrobit/kyroguard'
```

Guards throw these errors. Express sends the bodies below from `kyroguardExpress(guard).errorHandler()`. Fastify serializes the same `code` and status through its standard error shape. Both integrations accept a `formatError` option to change the body.

| Code | Status | Class |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | `UnauthenticatedError` |
| `ACCESS_DENIED` | 403 | `PolicyDeniedError` |
| `MISCONFIGURED` | 500 | `MisconfiguredError` |

::: warning Branch on `code`, not status or message
Messages are deliberately generic. The `code` field is the stable contract.
:::

## UNAUTHENTICATED

**Status 401.**

```json
{ "message": "Unauthorized", "code": "UNAUTHENTICATED" }
```

**When.** Your `getSubject` returned no user, or a user without an id. This is the normal path for requests with no session.

**Fix.** Return `null` from `getSubject` when nobody is logged in, and a user with a non-empty `id` otherwise. Check that the guard runs after your authentication middleware. See [Domains](/guide/domains).

## ACCESS_DENIED

**Status 403.**

```json
{ "message": "Forbidden", "code": "ACCESS_DENIED" }
```

**When.** The user does not hold this policy in this domain and tenant. Grants are exact: a grant in `school-1` never applies in `school-2`, and a grant in one domain never applies in another.

**Fix.** Grant the policy, or a group that holds it, at the same domain and tenant the request uses. The error's `policy` property carries the full policy name the engine checked. See [Assigning access](/guide/assigning-access).

::: info A scope never produces a 403
Holding a policy *with a scope* is still holding it, so the guard allows the request. The scope narrows the query instead — a row it excludes is simply not found, and your handler answers 404 from its own "no such row" branch. See [Scopes](/guide/scopes).
:::

## MISCONFIGURED

**Status 500.**

```json
{ "message": "[kyroguard] No request context for domain \"admin\" — register kyroguardExpress(guard).context() before its guards.", "code": "MISCONFIGURED" }
```

**When.** The library is wired incorrectly. A guard ran without the plugin (Fastify) or before the context middleware (Express), a route asked `filterFor` for a policy no registered resource declares, or `db.query` was asked for a relation that cannot be narrowed.

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
