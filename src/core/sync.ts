import { qualifyPolicyName } from './types.js'
import type { Policy } from './policy.js'
import type { StorageAdapter } from '../storage/contract.js'

/**
 * Sync policies-as-code into storage for one portal ('' sentinel = portal-less):
 * upsert, delete orphans (filtered on the stored portal column, S19), then
 * back-fill missing transitive dependencies into every group.
 *
 * An empty policy list returns early on purpose — it never wipes a portal.
 */
export async function syncPolicies(
  adapter: StorageAdapter,
  resources: { policies: Policy[] }[],
  portal?: string,
  options?: { logger?: (msg: string) => void },
): Promise<void> {
  const all = resources.flatMap(resource => resource.policies)
  if (all.length === 0) return

  const log = options?.logger ?? (() => {})

  const codeNames = new Set(all.map(policy => policy.name))
  for (const policy of all) {
    for (const dep of policy.dependsOn) {
      if (!codeNames.has(dep)) {
        throw new Error(`[rbac] Policy "${policy.name}" depends on "${dep}" which is not defined.`)
      }
    }
  }

  const portalSentinel = portal ?? ''
  const qualify = (name: string) => qualifyPolicyName(portalSentinel, name)

  await adapter.upsertPolicies(
    all.map(policy => ({
      name: qualify(policy.name),
      portal: portalSentinel,
      label: policy.label,
      scopeOptions: policy.scopeOptions.map(scope => scope.name),
      dependsOn: policy.dependsOn.map(qualify),
    })),
  )

  const records = await adapter.listPolicies()
  const qualifiedNames = new Set(all.map(policy => qualify(policy.name)))

  const orphans = records.filter(
    record => record.portal === portalSentinel && !qualifiedNames.has(record.name),
  )
  if (orphans.length > 0) {
    await adapter.deletePolicies(orphans.map(record => record.id))
    log(
      `[rbac] Removed ${orphans.length} orphaned policies: ${orphans
        .map(record => record.name)
        .join(', ')}`,
    )
  }

  await backfillGroupDependencies(adapter, resources, portal, options)

  log(`[rbac] Synced ${all.length} policies.`)
}

/**
 * Fill missing transitive dependsOn entries into every group (additive, S9).
 *
 * Called by syncPolicies, and AGAIN by the CLI after group seeding: seeding
 * is replace-all per group (S8), so dependencies filled before a seed would
 * be wiped by it — the post-seed pass is what makes them stick.
 */
export async function backfillGroupDependencies(
  adapter: StorageAdapter,
  resources: { policies: Policy[] }[],
  portal?: string,
  options?: { logger?: (msg: string) => void },
): Promise<void> {
  const all = resources.flatMap(resource => resource.policies)
  if (all.length === 0) return

  const log = options?.logger ?? (() => {})
  const portalSentinel = portal ?? ''
  const qualify = (name: string) => qualifyPolicyName(portalSentinel, name)
  const qualifiedNames = new Set(all.map(policy => qualify(policy.name)))

  const records = await adapter.listPolicies()
  const depsByName = new Map(
    records
      .filter(record => record.portal === portalSentinel && qualifiedNames.has(record.name))
      .map(record => [record.name, record.dependsOn]),
  )

  const groups = await adapter.listGroups()
  for (const group of groups) {
    const assigned = await adapter.getGroupPolicies(group.name)
    const assignedNames = new Set(assigned.map(entry => entry.policyName))
    const roots = [...assignedNames].filter(name => depsByName.has(name))

    const required = resolveWithDeps(roots, depsByName)
    const missing = [...required].filter(
      name => depsByName.has(name) && !assignedNames.has(name),
    )
    if (missing.length > 0) {
      await adapter.addGroupPolicies(
        group.name,
        missing.map(name => ({ policyName: name, scope: null })),
      )
      log(
        `[rbac] Filled ${missing.length} missing deps for group ${group.name}: ${missing.join(', ')}`,
      )
    }
  }
}

function resolveWithDeps(names: string[], depsByName: Map<string, string[]>): Set<string> {
  const visited = new Set<string>()
  const walk = (name: string): void => {
    if (visited.has(name)) return
    visited.add(name)
    for (const dep of depsByName.get(name) ?? []) walk(dep)
  }
  for (const name of names) walk(name)
  return visited
}
