import { eq, inArray } from 'drizzle-orm'
import { policyGroups, policyGroupPolicies, policies } from './schema.js'
import type { Policy } from './policy.js'

export type GroupPoliciesInput = 'all' | string[] | Record<string, string | null>

export interface GroupDefinition {
  label:    string
  policies: GroupPoliciesInput
}

export type GroupsDefinition = Record<string, GroupDefinition>

function normalise(
  input:      GroupPoliciesInput,
  allNames:   string[],
  groupId:    string,
): Record<string, string | null> {
  if (input === 'all') return Object.fromEntries(allNames.map(name => [name, null]))
  if (Array.isArray(input)) return Object.fromEntries(input.map(name => [name, null]))
  return input
}

export async function seedGroups(
  db:          any,
  groups:      GroupsDefinition,
  allPolicies?: Policy[],
): Promise<void> {
  const allNames = allPolicies?.map(p => p.name) ?? []

  for (const [id, group] of Object.entries(groups)) {
    if (group.policies === 'all' && !allPolicies) {
      throw new Error(
        `[rbac] seedGroups: group "${id}" uses policies: 'all' but no allPolicies array was passed as the third argument.`,
      )
    }

    await db
      .insert(policyGroups)
      .values({ id, name: id, label: group.label })
      .onConflictDoUpdate({
        target: policyGroups.id,
        set:    { label: group.label, updated_at: new Date() },
      })

    const policyMap = normalise(group.policies, allNames, id)
    const policyNames = Object.keys(policyMap)

    if (!policyNames.length) continue

    const rows = await db
      .select({ id: policies.id, name: policies.name })
      .from(policies)
      .where(inArray(policies.name, policyNames))

    const missing = policyNames.filter(n => !rows.find((r: any) => r.name === n))
    if (missing.length) {
      console.warn(`[rbac] seedGroups: unknown policies for group "${id}" (did you run sync?): ${missing.join(', ')}`)
    }

    await db
      .delete(policyGroupPolicies)
      .where(eq(policyGroupPolicies.policy_group_id, id))

    const inserts = rows.map((r: any) => ({
      policy_group_id: id,
      policy_id:       r.id,
      scope:           policyMap[r.name] ?? null,
    }))

    if (inserts.length) {
      await db.insert(policyGroupPolicies).values(inserts)
    }
  }
}
