import type { Policy } from './policy.js'
import type { RbacAdapter } from './adapter.js'

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

export interface ResourceDefinition {
  policies: Policy[]
}

export async function syncPolicies(
  adapter:   RbacAdapter,
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

  await adapter.upsertPolicies(all.map(p => ({ name: p.name, label: p.label, depends_on: p.dependsOn })))

  const allDbPolicies = await adapter.listAllPolicies()
  const orphans       = allDbPolicies.filter(r => !codeNames.has(r.name))

  if (orphans.length) {
    const orphanIds = orphans.map(r => r.id)
    await adapter.deleteGroupPolicies(orphanIds)
    await adapter.deleteUserPolicies(orphanIds)
    await adapter.deletePolicies(orphanIds)
    console.log(`[rbac] Removed ${orphans.length} orphaned policies: ${orphans.map(r => r.name).join(', ')}`)
  }

  const livePolicies = allDbPolicies.filter(r => codeNames.has(r.name))
  const depsByName   = new Map<string, string[]>(livePolicies.map(r => [r.name, r.depends_on]))
  const idByName     = new Map(livePolicies.map(r => [r.name, r.id]))

  const groups = await adapter.listGroups()

  for (const group of groups) {
    const assigned     = await adapter.getGroupPolicies(group.id)
    const assignedIds  = new Set(assigned.map(r => r.policy_id))
    const assignedNames = livePolicies.filter(r => assignedIds.has(r.id)).map(r => r.name)

    const required = resolveWithDeps(assignedNames, depsByName)
    const missing  = [...required].filter(name => {
      const id = idByName.get(name)
      return id && !assignedIds.has(id)
    })

    if (missing.length) {
      await adapter.insertGroupPolicies(
        missing.map(name => ({ policy_group_id: group.id, policy_id: idByName.get(name)!, scope: null }))
      )
      console.log(`[rbac] Filled ${missing.length} missing deps for group ${group.id}: ${missing.join(', ')}`)
    }
  }

  console.log(`[rbac] Synced ${all.length} policies.`)
}
