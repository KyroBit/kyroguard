# Example: Ownership Scope

A user can only update or delete records they created. Everyone else gets 403 — even if they hold the same policy, just without the restriction.

Use case: an HR system where employees can edit their own profile but not their colleagues'.

---

## Scenario

```
Employee Alice → PUT /employees/alice   → 200 OK   (her own record)
Employee Alice → PUT /employees/bob     → 403       (not her record)
HR Manager    → PUT /employees/alice   → 200 OK   (unrestricted)
HR Manager    → PUT /employees/bob     → 200 OK   (unrestricted)
```

Same policy. Same route. Different assignment → different result.

---

## Scope

The check receives the current user, the resource your route provides, and the database. Query `resourceOwners` — the library's ownership table — which is populated automatically on every insert through `db`:

```ts
// src/rbac/scopes.ts
import { Scope, resourceOwners } from '@kyrobit/rbac'
import { eq, and }               from 'drizzle-orm'

export const ownRecordScope = new Scope('own-record', 'Own Record',
  async (subject, resource, db) => {
    const rows = await db
      .select({ id: resourceOwners.id })
      .from(resourceOwners)
      .where(and(
        eq(resourceOwners.resource_type, resource.type),
        eq(resourceOwners.resource_id,   resource.id),
        eq(resourceOwners.owner_id,      subject.id),
      ))
      .limit(1)
    return rows.length > 0
  }
)
```

---

## Policies

```ts
// src/rbac/policies.ts
import { Policy, type ResourceDefinition } from '@kyrobit/rbac'
import { employees }      from '@/db/schema/employee.js'
import { ownRecordScope } from './scopes.js'

export const resources: ResourceDefinition[] = [
  {
    table:  employees,
    type:   'employee',
    policies: [
      new Policy('employee.read'),
      new Policy('employee.create', 'Create Employee', ['employee.read']),
      new Policy('employee.update', 'Update Employee', ['employee.read'], [ownRecordScope]),
      new Policy('employee.delete', 'Delete Employee', ['employee.read'], [ownRecordScope]),
    ],
  },
]
```

---

## Groups

```ts
// src/rbac/groups.ts
export const groups = {
  employee: {
    label: 'Employee',
    policies: {
      'employee.read':   null,          // can read anyone's profile
      'employee.update': 'own-record',  // only their own
      'employee.delete': 'own-record',  // only their own
    },
  },
  hr_manager: {
    label: 'HR Manager',
    policies: {
      'employee.read':   null,
      'employee.create': null,
      'employee.update': null,   // any employee
      'employee.delete': null,
    },
  },
  admin: {
    label:    'Admin',
    policies: 'all',
  },
}
```

---

## DB setup

```ts
// src/db/index.ts
import { createTrackedDb } from '@kyrobit/rbac'
import { resources } from '@/rbac/policies.js'

export const db = createTrackedDb(rawDb, { resources })
// db.insert(...)           → ownership recorded
// db.untracked.insert(...) → no ownership entry
```

---

## Plugin and subject setup

```ts
// src/plugins/rbac.ts
import { rbacPlugin, createDrizzleAdapter } from '@kyrobit/rbac'
import { db } from '@/db/index.js'

await app.register(rbacPlugin, {
  adapter: createDrizzleAdapter(db.untracked),
  db,
})

const rbac = app.rbac.forPortal('hr', (req) => ({ id: req.user.id }))
```

---

## Routes

Write through `db` so ownership is recorded. Provide a `resource` resolver on routes that may trigger a scope check:

```ts
// src/routes/employees.ts
import { eq } from 'drizzle-orm'
import { employees } from '@/db/schema/employee.js'

app.get('/employees', {
  preHandler: rbac.requirePolicy('employee.read'),
}, async () => db.select().from(employees))

app.post('/employees', {
  preHandler: rbac.requirePolicy('employee.create'),
}, async (req) => {
  const [employee] = await db   // ownership is recorded automatically
    .insert(employees).values(req.body)
    .returning()
  return employee
})

app.put('/employees/:id', {
  preHandler: rbac.requirePolicy('employee.update', {
    resource: (req) => ({ type: 'employee', id: req.params.id }),
  }),
}, async (req) => {
  const [employee] = await db
    .update(employees).set(req.body)
    .where(eq(employees.id, req.params.id))
    .returning()
  return employee
})

app.delete('/employees/:id', {
  preHandler: rbac.requirePolicy('employee.delete', {
    resource: (req) => ({ type: 'employee', id: req.params.id }),
  }),
}, async (req) => {
  await db.delete(employees).where(eq(employees.id, req.params.id))
  return { ok: true }
})
```

---

## How it plays out at request time

```
PUT /employees/alice   (subject: Alice, group: employee)
  → policy: employee.update, scope: 'own-record'
  → ownRecordScope.check({ id: alice.id }, { type: 'employee', id: 'alice' })
  → SELECT WHERE resource_id = 'alice' AND owner_id = alice.id → found → 200 OK

PUT /employees/bob     (subject: Alice, group: employee)
  → same scope check
  → SELECT WHERE resource_id = 'bob' AND owner_id = alice.id → not found → 403 Forbidden

PUT /employees/bob     (subject: HR Manager, scope: null)
  → scope is null → check skipped → 200 OK
```

---

## Assigning users

```ts
// New hire — can only manage their own profile
await rbac.assignGroup(userId, 'employee')

// Promote to HR manager — unrestricted access
await rbac.removeGroup(userId, 'employee')
await rbac.assignGroup(userId, 'hr_manager')
app.rbac.clearPolicyCache(userId)
```

---

**Next:** [Multi-tenant branch system](./multi-tenant)
