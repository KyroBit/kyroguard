# Policies

A policy is one permission.

```ts
import { Policy } from '@kyrobit/kyroguard'

new Policy('grades.enter')
```

That is a complete policy. Routes check it. Groups bundle it. You grant it to users.

Only the name is required. Everything else — label, dependencies, scopes — is optional, passed as an options object. Each gets a section below.

## Names

```ts
new Policy('grades.view')
new Policy('grades.enter')
new Policy('grades.update')
```

Name policies `resource.action`. The name is what you check on a route:

```ts
app.get('/grades', { preHandler: teachers.requirePolicy('grades.view') }, listGrades)
```

Write names without a domain prefix. Domains add theirs for you. See [Multi-tenancy](/guide/multi-tenancy).

## Labels

The label is the display name for your admin screens. It is the action part of the name, capitalized — admin screens group permissions by resource, so the label only needs the verb:

```ts
new Policy('grades.enter')      // label: "Enter"
new Policy('grades.mark-final') // label: "Mark final"
```

Pass your own when the derived one reads wrong:

```ts
new Policy('grades.enter', 'Enter a grade')
// or in the options form:
new Policy('grades.enter', { label: 'Enter a grade' })
```

## Dependencies

```ts
new Policy('grades.update', { dependsOn: ['grades.view'] })
```

You must see a grade to update it. `dependsOn` declares that once. At sync, every group that has `grades.update` gets `grades.view` added. `grades.enter` and `grades.delete` depend on `grades.view` the same way. See [Sync](/guide/sync).

Dependencies chain:

```ts
new Policy('grades.finalize', { dependsOn: ['grades.update'] })
```

A group with `grades.finalize` also gets `grades.update` and `grades.view`.

A filled-in dependency inherits the scope of the grant that pulled it in ([Groups](/guide/groups#dependencies-are-filled-in)).

A dependency must name a policy you defined. Sync fails if it does not.

## Scopes

```ts
import { Scope } from '@kyrobit/kyroguard'

new Policy('grades.update', { dependsOn: ['grades.view'], scopeOptions: [Scope.owned()] })
```

`scopeOptions` lists the conditions this policy may be granted with. `Scope.owned()` lets a teacher update only the grades they entered ([Scopes](/guide/scopes)).

The list is enforced. Granting a scope the policy does not declare fails, at sync and at assignment ([Errors](/reference/errors#unknownscopeerror)).

## A complete policies.ts

```ts
// src/kyroguard/policies.ts
import { Policy, Scope } from '@kyrobit/kyroguard'
import type { ResourceDefinition } from '@kyrobit/kyroguard'

export const resources: ResourceDefinition[] = [
  {
    type: 'grade',
    // table: grades,       // your Drizzle table or Mongoose model (optional):
    //                      // enables ownership tracking and read filtering
    policies: [
      new Policy('grades.view', { scopeOptions: [Scope.inTenant()] }),
      new Policy('grades.enter', { dependsOn: ['grades.view'] }),
      new Policy('grades.update', {
        dependsOn: ['grades.view'],
        scopeOptions: [Scope.owned(), Scope.inTenant()],
      }),
      new Policy('grades.delete', {
        dependsOn: ['grades.view'],
        scopeOptions: [Scope.inTenant()],
      }),
    ],
  },
]
```

Export the array as `resources`. Point [`kyroguard.config.ts`](/reference/configuration) at this file. Run `npx kyroguard sync` to push it to the database.

`type` names the resource for scoped checks and ownership. `table` is optional — set it to record who entered each row ([Ownership](/guide/ownership)). Reads on guarded routes are then filtered automatically ([Scopes](/guide/scopes#automatic-filtering)).

## Next steps

- [Groups](/guide/groups) — bundle policies into job titles
- [Sync](/guide/sync) — push policies to the database
- [Protecting routes](/guide/protecting-routes) — check policies in your app
