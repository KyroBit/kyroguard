# Super users

`is_super` marks a break-glass account that bypasses every policy check. On this page you mark a subject as super, see exactly where the bypass happens, and put the guardrails around it — strict typing, a global off switch, and an audit trail.

::: tip Prerequisites
Subjects and `getSubject` are covered in [Portals](/guide/portals); the decision procedure they feed into is in [Protecting routes](/guide/protecting-routes).
:::

## 1. Mark the subject

Set `is_super: true` on the subject your `getSubject` returns, sourced from trusted server-side data:

```ts
const admin = app.rbac.portal('admin', {
  getSubject: async request => {
    const staff = await resolveStaffSession(request) // your auth
    if (!staff) return null
    return {
      id: staff.id,
      is_super: staff.isSuper, // a boolean column you control
    }
  },
})
```

A super subject passes every `requirePolicy` guard in every portal and context, with no grants in storage at all.

::: danger Never derive `is_super` from request input
Headers, body fields and client-editable JWT claims are attacker-controlled. `is_super` must come from data the server owns — a database column, a server-side session. A subject with `is_super: true` skips portals, contexts, policies and scopes; treat the code path that sets it like the credential it is.
:::

## 2. Know where the bypass happens

The check sits at the top of the engine's decision procedure, before the policy lookup:

1. No subject → `401 RBAC_UNAUTHENTICATED`.
2. **`is_super === true` → allow. Stop.**
3. Load the policy map (cache or storage), match the policy, run scopes.

Because step 2 runs before step 3, a super request performs no cache read, no storage query and no scope check — nothing you grant, revoke or misconfigure in storage can lock out (or further restrict) a super account. That is the point of a break-glass account: it must keep working while the data it would depend on is being repaired. The one thing that still applies is authentication — a super subject with no `id` is still a 401.

## 3. Boolean `true` only — by design

The engine compares with strict equality:

```ts
if (this.superBypass && subject.is_super === true) { /* allow */ }
```

The string `'true'`, the number `1`, and any other truthy value do **not** bypass:

```ts
return { id: staff.id, is_super: staff.isSuper }          // boolean true → bypasses
return { id: staff.id, is_super: 'true' }                 // string → does NOT bypass
return { id: staff.id, is_super: 1 }                      // number → does NOT bypass
```

This is deliberate, and regression-tested. Subjects are often assembled from JWT claims, HTTP headers, environment variables and raw database rows — all channels where booleans quietly become strings (`'true'`, `'1'`, `'t'`). Under a truthy check, one serialization bug anywhere in your auth pipeline would grant a global bypass. Under strict equality the same bug fails toward "no bypass": the account loses its shortcut and falls through to normal policy checks, which is the safe direction. If a super account unexpectedly gets `403`s, inspect `typeof subject.is_super` first.

## 4. Disable the bypass globally

If your deployment policy forbids bypass accounts, turn the mechanism off at construction:

```ts
const rbac = createRbac({
  adapter,
  resources,
  superBypass: false,
})
```

With `superBypass: false` the flag is ignored entirely and every subject — `is_super` or not — goes through the normal policy lookup. A flagged account with no grants is then denied like anyone else, with `403`:

```json
{
  "message": "Forbidden",
  "code": "RBAC_POLICY_DENIED"
}
```

The default is `true` (the bypass is active). There is no per-request or per-portal toggle — the switch is engine-wide, so an audit of one `createRbac` call answers "can anyone bypass policy checks here".

## 5. Run break-glass accounts, not super admins

`is_super` is an emergency mechanism, not a convenience role:

- **Keep zero standing supers.** Day-to-day administrators should hold an `admin` group with explicit policies — visible, revocable, and scoped like any other grant. Reserve `is_super` for repairing the system the admin group lives in (broken group seeds, a bad sync, a locked-out operator).
- **Time-box it.** Flip the flag on for the incident, off after. Because the bypass reads the subject — not stored grants — flipping the database column takes effect on the next request, with no cache to wait out.
- **Audit every use.** The engine fires the `onDecision` hook on every decision; a super bypass arrives with `reason: 'super'`:

```ts
const rbac = createRbac({
  adapter,
  resources,
  onDecision: event => {
    if (event.reason === 'super') {
      logger.warn(
        { subjectId: event.subjectId, portal: event.portal, policy: event.policy },
        'super bypass used',
      )
    }
  },
})
```

An alert on `reason: 'super'` outside a declared incident window is the cheapest intrusion detector this package offers. The hook's full event shape and other reasons are covered on the [observability page](/guide/observability).

## Next steps

- [Observability](/guide/observability) — the `onDecision` hook and what every decision event carries
- [Assigning access](/guide/assigning-access) — explicit, revocable grants for day-to-day admins
- [Tenant contexts](/guide/tenant-contexts) — the isolation rules `is_super` steps over
