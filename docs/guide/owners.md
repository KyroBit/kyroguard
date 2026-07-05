# Owners and superusers

Your admins can hold every policy. So why does `is_super` exist?

**A role is what your app gives someone. Ownership is who they are.** The difference shows up in three moments every real system hits.

## Day zero

You just opened branch-2. Nobody there has a role yet — and there is no one who could hand them out. The owner can already do everything, because ownership is not something you are given:

```ts
const staff = app.rbac.domain('branch', {
  getSubject: async req => {
    const user = await auth(req)
    const branchId = req.headers['x-branch-id'] as string
    return {
      id: user.id,
      tenant_id: branchId,
      // Owner of THIS branch? Every check passes here — and only here.
      is_super: user.owned_branch_id === branchId,
    }
  },
})
```

That is the whole mechanism. `is_super` is computed per request, from your own users table. Amina owns branch-1: there she passes every check and hires the first manager. In branch-2 she is an ordinary user — whatever roles she holds there, nothing more.

## The bad day

A broken deploy wipes everyone's permissions. Every admin is locked out — their access was something the app gave them, and the app lost it. The owner still gets in and puts things back, because their access was never the app's to lose.

## The org chart

Five admins, one owner. The admins hold `policies: 'all'` — they can run the whole store:

```ts
// groups.ts
admin: { label: 'Administrator', policies: 'all' },
```

But admins manage roles, so anything role-based an admin can take away — from a cashier, from another admin. Nobody can take ownership away from inside the app. It moves only when you transfer it in your own data.

For the actions that touch the owner themselves — deleting the owner's account, demoting them, transferring ownership — check the **target**, not just the actor: if the user being edited is the owner, only a request with `is_super` proceeds.

## Which one do you reach for?

| | Admin (`policies: 'all'`) | Owner (`is_super`) |
|---|---|---|
| What it is | A role that happens to grant everything | A per-request bypass — checks are skipped |
| Where it lives | Assigned in your app, like any role | Computed by your `getSubject`, per request |
| Policies you ship later | Picked up on the next sync | Covered automatically |
| Removable from your admin screens | Yes | No — only by transferring ownership |
| After permissions are wiped | Locked out | Still gets in |
| Scopes | Apply normally | Never apply |
| Audit log | Each policy, `reason: 'granted'` | `reason: 'super'` |

The rule of thumb: **if someone should be able to lose the access, it is a role.** Reserve `is_super` for the person the business belongs to — and keep that set tiny, because super requests skip scopes and per-policy audit detail. Every bypass still lands in the [audit hook](/guide/production) as `reason: 'super'`, so owner activity stays visible.

To turn the bypass off globally — some deployments want no superusers at all — pass `superBypass: false` to `createRbac`.

## Next steps

- [Multi-tenancy](/guide/multi-tenancy) — domains and tenants, where per-branch ownership lives.
- [Assigning access](/guide/assigning-access) — hiring staff into roles.
- [Production](/guide/production) — the audit hook that records super bypasses.
