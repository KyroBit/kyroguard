import { Policy, Scope } from '@kyrobit/kyroguard'
import type { ResourceDefinition } from '@kyrobit/kyroguard'

// Starter resources — replace with your own, then run `kyroguard sync`.
// Policy names are UNQUALIFIED: the domain prefix is added automatically.
export const resources: ResourceDefinition[] = [
  {
    type: 'grade',
    // table: grades, // link your Drizzle table / Mongoose model to enable
    //                // ownership auto-tracking and query scoping
    policies: [
      new Policy('grades.view', { scopeOptions: [Scope.inTenant()] }),
      new Policy('grades.enter', { dependsOn: ['grades.view'] }),
      new Policy('grades.update', { dependsOn: ['grades.view'], scopeOptions: [Scope.owned(), Scope.inTenant()] }),
      new Policy('grades.delete', { dependsOn: ['grades.view'], scopeOptions: [Scope.inTenant()] }),
    ],
  },
]
