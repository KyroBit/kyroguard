# Policies

A policy is a named permission — the smallest unit of access in `@kyrobit/rbac`. Each policy represents one action: `transaction.view`, `blog.publish`, `user.invite`.

---

## Policy constructor

```ts
new Policy(name, label?, dependsOn?, scopeOptions?)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Unique identifier. Use `resource.action` format. |
| `label` | `string` | Human-readable name shown in admin UIs. Auto-generated from the name if omitted. |
| `dependsOn` | `string[]` | Policies that are automatically granted alongside this one. |
| `scopeOptions` | `Scope[]` | Scope objects that may be assigned with this policy. Used by admin UIs to present valid options. |

---

## Naming convention

Always use `resource.action`. Keep it lowercase, use dots:

```ts
new Policy('transaction.view')
new Policy('transaction.create')
new Policy('transaction.void')
new Policy('blog.publish')
new Policy('user.invite')
```

Never include the portal name — the library adds it internally. If you have a `transaction.view` policy in your `branch` portal, it is stored as `branch.transaction.view` in the database. You always write just `transaction.view`.

---

## dependsOn

When one action implies another, list the implied policies in `dependsOn`. They are granted automatically — you don't need to add them manually to every group that uses the policy.

```ts
new Policy('transaction.void', 'Void Transaction', ['transaction.view'])
// Assigning 'transaction.void' automatically includes 'transaction.view'
```

Dependencies are resolved at sync time for groups and at assignment time for direct grants.

---

## scopeOptions

The fourth argument tells admin UIs which scopes are valid options when assigning this policy to a group. Pass the actual `Scope` objects — you get full intellisense and no typos:

```ts
import { branchOwned } from '@/rbac/scopes.js'

new Policy('transaction.void', 'Void Transaction', ['transaction.view'], [branchOwned])
// When building a group definition, valid scope choices are null (unrestricted) or branchOwned
```

`null` (unrestricted) is always a valid choice. See [Scopes](./scopes) for how scope checks work at request time.

---

## ResourceDefinition

Policies are declared inside a `ResourceDefinition`, which connects them to a Drizzle table:

```ts
// src/rbac/policies.ts
import { Policy, type ResourceDefinition } from '@kyrobit/rbac'
import { transactions } from '@/db/schema.js'
import { branchOwned }  from '@/rbac/scopes.js'

export const resources: ResourceDefinition[] = [
  {
    table:    transactions,
    type:     'transaction',
    policies: [
      new Policy('transaction.view'),
      new Policy('transaction.create', 'Create', ['transaction.view']),
      new Policy('transaction.void',   'Void',   ['transaction.view'], [branchOwned]),
    ],
  },
]
```

The `table` field tells `createTrackedDb` which inserts to intercept for ownership tracking. The `type` field is the string written to `rbac_resource_owners.resource_type` and matched in scope checks.

Scope check functions (`Scope` objects) are registered separately at the plugin level — not inside the resource definition. See [Scopes](./scopes).

---

**Next:** [Groups](./groups)
