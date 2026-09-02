import { Policy, Scope } from '@kyrobit/kyroguard'
import type { ResourceDefinition } from '@kyrobit/kyroguard'

// A scope is your rule, over your own columns. Swap the placeholder below for a
// condition your ORM understands — Drizzle `eq(grades.enteredBy, subject.id)`,
// Prisma/Mongoose `{ enteredBy: subject.id }` — and kyroguard adds it to every
// query for this resource: reads, updates and deletes alike.
const entered = new Scope('entered', 'Entered by the subject', subject => ({
  where: { enteredBy: subject.id },
}))

// Starter resources — replace with your own, then run `kyroguard sync`.
// Policy names are UNQUALIFIED: the domain prefix is added automatically.
export const resources: ResourceDefinition[] = [
  {
    type: 'grade',
    // table: grades, // link your Drizzle table / Mongoose model to enable
    //                // automatic query filtering
    policies: [
      new Policy('grades.view'),
      new Policy('grades.enter'),
      new Policy('grades.update', { dependsOn: ['grades.view'], scopeOptions: [entered] }),
      new Policy('grades.delete', { dependsOn: ['grades.view'], scopeOptions: [entered] }),
    ],
  },
]
