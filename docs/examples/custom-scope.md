# Example: Custom Scopes

Scopes aren't limited to ownership checks. The check function can do anything — query your database, look at the time, inspect the request, call an external API. This example shows three different types: time-based, network-based, and subscription-based.

---

## Scenario

A payment app with two roles:
- **Manager** — can process refunds at any time, from anywhere
- **Cashier** — can only process refunds during business hours, from the office network

---

## Scopes

```ts
// src/rbac/scopes.ts
import { Scope } from '@kyrobit/rbac'

export const scopes = [

  // Only allowed Monday–Friday, 09:00–17:00
  new Scope('business-hours', 'Business Hours Only',
    () => {
      const now  = new Date()
      const day  = now.getDay()    // 0 = Sunday, 6 = Saturday
      const hour = now.getHours()
      return day >= 1 && day <= 5 && hour >= 9 && hour < 17
    }
  ),

  // Only allowed from the internal office network
  new Scope('office-network', 'Office Network Only',
    (subject) => {
      const ip = subject.ip as string
      return ip?.startsWith('10.0.') || ip?.startsWith('192.168.')
    }
  ),

  // Only allowed for users with an active paid subscription
  new Scope('active-subscription', 'Active Subscription',
    async (subject, _resource, db) => {
      const [user] = await db
        .select({ plan: users.plan, planExpiresAt: users.planExpiresAt })
        .from(users)
        .where(eq(users.id, subject.id))
        .limit(1)
      return user?.plan === 'paid' && user.planExpiresAt > new Date()
    }
  ),

]
```

---

## Pass extra fields via forPortal

The subject carries whatever you return from `forPortal`. Add the user's IP so the `office-network` scope can check it:

```ts
const rbac = app.rbac.forPortal('branch', (req) => ({
  id:         req.user.id,
  ip:         req.ip,                // used by 'office-network' scope
  context_id: req.user.branchId,
}))
```

---

## Policies

```ts
new Policy('payment.view'),
new Policy('payment.refund', 'Refund Payment', ['payment.view'], [businessHours, officeNetwork]),
```

---

## Groups

```ts
// src/rbac/groups.ts
export const groups = {
  manager: {
    label: 'Manager',
    policies: {
      'payment.view':   null,
      'payment.refund': null,   // unrestricted
    },
  },
  cashier: {
    label: 'Cashier',
    policies: {
      'payment.view':   null,
      'payment.refund': 'business-hours',   // time-restricted
    },
  },
}
```

---

## Route

```ts
app.post('/payments/:id/refund', {
  preHandler: rbac.requirePolicy('payment.refund', {
    resource: (req) => ({ type: 'payment', id: req.params.id }),
  }),
}, async (req) => {
  return processRefund(req.params.id)
})
```

A cashier calling this at 20:00 gets 403. At 10:00 it passes. A manager always passes — their assignment has `scope: null`.

---

## Overriding a scope temporarily

Grant a direct policy assignment with `scope: null` to bypass the scope for a specific user. Because `null` beats any scope string (least-restrictive wins), this overrides their group's `business-hours` restriction:

```ts
import { assignPolicy, removePolicy } from '@kyrobit/rbac'

// Temporarily grant unrestricted access
await assignPolicy(db, userId, 'payment.refund', { scope: null })
app.rbac.clearPolicyCache(userId)

// Revoke it later
await removePolicy(db, userId, 'payment.refund')
app.rbac.clearPolicyCache(userId)
```

---

## Scope check reference

| Scope name | What it checks |
|---|---|
| `'written-by-me'` | `owner_id = subject.id` in `rbac_resource_owners` |
| `'same-branch'` | `context_id = subject.context_id` in `rbac_resource_owners` |
| `'business-hours'` | Weekday, 09:00–17:00 |
| `'office-network'` | `subject.ip` starts with an internal range |
| `'active-subscription'` | User's plan is `'paid'` and hasn't expired |

Any function that returns a boolean works. The library calls it and enforces the result.

---

**Next:** [Super user & emergency access](./super-user)
