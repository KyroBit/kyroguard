import { eq, inArray } from 'drizzle-orm'
import { policies, policyGroups, policyGroupPolicies, userPolicies } from './schema.js'
import type { Policy, ResourceDefinition } from './policy.js'

function resolveWithDeps(names: string[], byName: Map<string, string[]>): Set<string> {
  const resolved = new Set<string>()

  function walk(name: string) {
    if (resolved.has(name)) return
    resolved.add(name)
    for (const dep of byName.get(name) ?? []) walk(dep)
  }

  for (const name of names) walk(name)
  return resolved
}

export async function syncPolicies(
  db:        any,
  resources: ResourceDefinition[],
): Promise<void> {
  const all: Policy[] = resources.flatMap(r => r.policies)

  if (!all.length) return

  const codeNames = new Set(all.map(p => p.name))
  for (const p of all) {
    for (const dep of p.dependsOn) {
      if (!codeNames.has(dep)) {
        throw new Error(`[rbac] Policy "${p.name}" depends on "${dep}" which is not defined.`)
      }
    }
  }

  await db
    .insert(policies)
    .values(all.map(p => ({
      name:       p.name,
      label:      p.label,
      depends_on: p.dependsOn,
    })))
    .onConflictDoUpdate({
      target: policies.name,
      set:    {
        label:      policies.label,
        depends_on: policies.depends_on,
        updated_at: new Date(),
      },
    })

  const allDbPolicies = await db.select({ id: policies.id, name: policies.name, depends_on: policies.depends_on }).from(policies)
  const orphans       = allDbPolicies.filter((r: any) => !codeNames.has(r.name))

  if (orphans.length) {
    const orphanIds = orphans.map((r: any) => r.id)
    await db.delete(policyGroupPolicies).where(inArray(policyGroupPolicies.policy_id, orphanIds))
    await db.delete(userPolicies).where(inArray(userPolicies.policy_id, orphanIds))
    await db.delete(policies).where(inArray(policies.id, orphanIds))
    console.log(`[rbac] Removed ${orphans.length} orphaned policies: ${orphans.map((r: any) => r.name).join(', ')}`)
  }

  const livePolicies = allDbPolicies.filter((r: any) => codeNames.has(r.name))
  const depsByName   = new Map<string, string[]>(livePolicies.map((r: any) => [r.name as string, r.depends_on as string[]]))
  const idByName     = new Map(livePolicies.map((r: any) => [r.name, r.id as string]))

  const groups = await db.select({ id: policyGroups.id }).from(policyGroups)

  for (const group of groups) {
    const assigned = await db
      .select({ policy_id: policyGroupPolicies.policy_id })
      .from(policyGroupPolicies)
      .where(eq(policyGroupPolicies.policy_group_id, group.id))

    const assignedIds  = new Set(assigned.map((r: any) => r.policy_id as string))
    const assignedNames = livePolicies
      .filter((r: any) => assignedIds.has(r.id))
      .map((r: any) => r.name as string)

    const required = resolveWithDeps(assignedNames, depsByName)
    const missing  = [...required].filter(name => {
      const id = idByName.get(name)
      return id && !assignedIds.has(id)
    })

    if (missing.length) {
      await db.insert(policyGroupPolicies).values(
        missing.map(name => ({
          policy_group_id: group.id,
          policy_id:       idByName.get(name)!,
          scope:           null,
        }))
      )
      console.log(`[rbac] Filled ${missing.length} missing deps for group ${group.id}: ${missing.join(', ')}`)
    }
  }

  console.log(`[rbac] Synced ${all.length} policies.`)
}
