import { qualifyPolicyName } from './types.js'
import type { Policy } from './policy.js'
import type { StorageAdapter } from '../storage/contract.js'

/**
 * Sync policies-as-code into storage for one domain. Orphan cleanup filters
 * on the stored domain column (S19). An empty policy list returns early on
 * purpose — it never wipes a domain.
 */
export async function syncPolicies(
  adapter: StorageAdapter,
  resources: { policies: Policy[] }[],
  domain?: string,
  options?: { logger?: (msg: string) => void },
): Promise<void> {
  const all = resources.flatMap(resource => resource.policies)
  if (all.length === 0) return

  const log = options?.logger ?? (() => {})

  const codeNames = new Set(all.map(policy => policy.name))
  for (const policy of all) {
    for (const dep of policy.dependsOn) {
      if (!codeNames.has(dep)) {
        throw new Error(`[kyroguard] Policy "${policy.name}" depends on "${dep}" which is not defined.`)
      }
    }
  }

  const domainSentinel = domain ?? ''
  const qualify = (name: string) => qualifyPolicyName(domainSentinel, name)

  await adapter.upsertPolicies(
    all.map(policy => ({
      name: qualify(policy.name),
      domain: domainSentinel,
      label: policy.label,
      scopeOptions: policy.scopeOptions.map(scope => scope.name),
      dependsOn: policy.dependsOn.map(qualify),
    })),
  )

  const records = await adapter.listPolicies()
  const qualifiedNames = new Set(all.map(policy => qualify(policy.name)))

  const orphans = records.filter(
    record => record.domain === domainSentinel && !qualifiedNames.has(record.name),
  )
  if (orphans.length > 0) {
    await adapter.deletePolicies(orphans.map(record => record.id))
    log(
      `[kyroguard] Removed ${orphans.length} orphaned policies: ${orphans
        .map(record => record.name)
        .join(', ')}`,
    )
  }

  await backfillGroupDependencies(adapter, resources, domain, options)

  log(`[kyroguard] Synced ${all.length} policies.`)
}

/**
 * Fill missing transitive dependsOn entries into every group (additive, S9).
 * Must run AGAIN after group seeding — seeding is replace-all per group (S8)
 * and wipes dependencies filled before it.
 */
export async function backfillGroupDependencies(
  adapter: StorageAdapter,
  resources: { policies: Policy[] }[],
  domain?: string,
  options?: { logger?: (msg: string) => void },
): Promise<void> {
  const all = resources.flatMap(resource => resource.policies)
  if (all.length === 0) return

  const log = options?.logger ?? (() => {})
  const domainSentinel = domain ?? ''
  const qualify = (name: string) => qualifyPolicyName(domainSentinel, name)
  const qualifiedNames = new Set(all.map(policy => qualify(policy.name)))

  const records = await adapter.listPolicies()
  const depsByName = new Map(
    records
      .filter(record => record.domain === domainSentinel && qualifiedNames.has(record.name))
      .map(record => [record.name, record.dependsOn]),
  )

  const groups = await adapter.listGroups()
  for (const group of groups) {
    const assigned = await adapter.getGroupPolicies(group.name)
    const explicitScopes = new Map(assigned.map(entry => [entry.policyName, entry.scope]))

    // Least privilege: a filled-in dependency inherits the scope of the grant
    // that pulled it in; null (unrestricted) wins on merge, conflicting named
    // scopes fall back to unrestricted with a warning. Explicit entries are
    // never overwritten.
    const effective = new Map<string, string | null>()
    const conflicts = new Set<string>()
    for (const [name, scope] of explicitScopes) {
      if (depsByName.has(name)) effective.set(name, scope)
    }

    let changed = true
    while (changed) {
      changed = false
      for (const [name, scope] of effective) {
        for (const dep of depsByName.get(name) ?? []) {
          const next = explicitScopes.has(dep)
            ? explicitScopes.get(dep)!
            : mergeDependencyScope(effective.get(dep), scope, effective.has(dep), dep, conflicts)
          if (!effective.has(dep) || effective.get(dep) !== next) {
            effective.set(dep, next)
            changed = true
          }
        }
      }
    }

    const missing = [...effective.keys()].filter(name => !explicitScopes.has(name))
    if (missing.length > 0) {
      await adapter.addGroupPolicies(
        group.name,
        missing.map(name => ({ policyName: name, scope: effective.get(name) ?? null })),
      )
      log(
        `[kyroguard] Filled ${missing.length} missing deps for group ${group.name}: ${missing
          .map(name => `${name}${effective.get(name) ? ` (scope: ${effective.get(name)})` : ''}`)
          .join(', ')}`,
      )
      for (const name of conflicts) {
        log(
          `[kyroguard] WARNING: "${name}" is required by grants with different scopes in group ${group.name} — filled unrestricted. Define it explicitly in the group to control its scope.`,
        )
      }
    }
  }
}

function mergeDependencyScope(
  current: string | null | undefined,
  incoming: string | null,
  hasCurrent: boolean,
  dep: string,
  conflicts: Set<string>,
): string | null {
  if (!hasCurrent) return incoming
  if (current === null || incoming === null) return null
  if (current === incoming) return current
  conflicts.add(dep)
  return null
}
