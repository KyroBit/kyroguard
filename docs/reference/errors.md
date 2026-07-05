# Errors

Every denial is a typed error with a stable `code`.

```ts
import {
  RbacError,
  UnauthenticatedError,
  PolicyDeniedError,
  ScopeDeniedError,
  ResourceNotFoundError,
  MisconfiguredError,
} from '@kyrobit/rbac'
```

Guards throw these errors. Express sends the bodies below from `rbacExpress(rbac).errorHandler()`. Fastify serializes the same `code` and status through its standard error shape. Both integrations accept a `formatError` option to change the body.

| Code | Status | Class |
| --- | --- | --- |
| `RBAC_UNAUTHENTICATED` | 401 | `UnauthenticatedError` |
| `RBAC_POLICY_DENIED` | 403 | `PolicyDeniedError` |
| `RBAC_SCOPE_DENIED` | 403 | `ScopeDeniedError` |
| `RBAC_RESOURCE_NOT_FOUND` | 404 | `ResourceNotFoundError` |
| `RBAC_MISCONFIGURED` | 500 | `MisconfiguredError` |

::: warning Branch on `code`, not status or message
Two denials share status 403, and messages are deliberately generic. The `code` field is the stable contract.
:::

## RBAC_UNAUTHENTICATED

**Status 401.**

```json
{ "message": "Unauthorized", "code": "RBAC_UNAUTHENTICATED" }
```

**When.** Your `getSubject` returned no user, or a user without an id. This is the normal path for requests with no session.

**Fix.** Return `null` from `getSubject` when nobody is logged in, and a user with a non-empty `id` otherwise. Check that the guard runs after your authentication middleware. See [Portals](/guide/portals).

## RBAC_POLICY_DENIED

**Status 403.**

```json
{ "message": "Forbidden", "code": "RBAC_POLICY_DENIED" }
```

**When.** The user does not hold this policy in this portal and context. Grants are exact: a grant in `branch-1` never applies in `branch-2`, and a grant in one portal never applies in another.

**Fix.** Grant the policy, or a group that holds it, at the same portal and context the request uses. The error's `policy` property carries the full policy name the engine checked. See [Assigning access](/guide/assigning-access).

## RBAC_SCOPE_DENIED

**Status 403.**

```json
{ "message": "Forbidden", "code": "RBAC_SCOPE_DENIED" }
```

**When.** The policy is granted, but with a scope, and the scope check failed. It also fires when the route has no `resource` resolver, or the scope name is unknown. Missing wiring denies rather than allowing too much.

**Fix.** Add a `resource` resolver to every route whose policy can carry a scope, and pass your `resources` to `createRbac`. For `Scope.owned()`, check the ownership rows with `rbac.ownership.isOwner()`. See [Scopes](/guide/scopes) and [Ownership](/guide/ownership).

## RBAC_RESOURCE_NOT_FOUND

**Status 404.**

```json
{ "message": "Not found", "code": "RBAC_RESOURCE_NOT_FOUND" }
```

**When.** The grant is scoped and the route's `resource` resolver returned nothing. The target does not exist for this request.

**Fix.** Test the resolver with a known-good id. It only runs for scoped grants, so a resolver bug can hide until the first scoped user hits the route.

## RBAC_MISCONFIGURED

**Status 500.**

```json
{ "message": "[rbac] No request context for portal \"admin\" — register rbacExpress(rbac).context() before its guards.", "code": "RBAC_MISCONFIGURED" }
```

**When.** The library is wired incorrectly. A guard ran without the plugin (Fastify) or before the context middleware (Express), or a tracked insert could not be attributed with `strictTracking: 'error'`.

**Fix.** Register `rbacFastify(rbac)` before your routes, or `rbacExpress(rbac).context()` before any guard. Seeing this code in production means a wiring regression, not user behavior. See [Protecting routes](/guide/protecting-routes).

## UnknownPolicyError

Not an HTTP error. It is thrown from assignment calls, not guards, and has no `statusCode`.

```
[rbac] Policy "admin.posts.read" not found — run `rbac sync` first.
```

**When.** `assignPolicy` named a policy that is not in the database. Assignments reference synced policies.

**Fix.** Run `rbac sync`. Prefer the portal assignment methods, which add the portal prefix for you. Catch it with `instanceof UnknownPolicyError` where you expose assignment endpoints.

```ts
import { UnknownPolicyError } from '@kyrobit/rbac'

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
