import { qualifyPolicyName } from './types.js'
import type { GroupPolicyEntry, StorageAdapter } from '../storage/contract.js'

/** Policy names are UNQUALIFIED — seedGroups qualifies them with the domain sentinel. */
export type GroupPoliciesInput = 'all' | string[] | Record<string, string | null>

export interface GroupDefinition {
  label: string
  description?: string
  policies: GroupPoliciesInput
}

export type GroupsDefinition = Record<string, GroupDefinition>

/** Structurally matches core Policy — scopeOptions members only need a name. */
export interface SeedPolicyInfo {
  name: string
  scopeOptions?: readonly { name: string }[]
}

export async function seedGroups(
  adapter: StorageAdapter,
  groups: GroupsDefinition,
  allPolicies?: SeedPolicyInfo[],
  domain?: string,
): Promise<void> {
  const domainSentinel = domain ?? ''

  for (const [name, def] of Object.entries(groups)) {
    if (def.policies === 'all' && !allPolicies) {
      throw new Error(
        `[rbac] seedGroups: group "${name}" uses policies: 'all' but no allPolicies array was passed as the third argument.`,
      )
    }

    const normalized = normalize(def.policies, allPolicies ?? [])
    validateScopes(name, normalized, allPolicies)
    const entries: GroupPolicyEntry[] = Object.entries(normalized).map(([policyName, scope]) => ({
      policyName: qualifyPolicyName(domainSentinel, policyName),
      scope,
    }))

    await adapter.upsertGroup({
      name,
      label: def.label,
      description: def.description,
    })
    await adapter.setGroupPolicies(name, entries)
  }
}

function validateScopes(
  group: string,
  policies: Record<string, string | null>,
  allPolicies?: SeedPolicyInfo[],
): void {
  if (!allPolicies) return
  const byName = new Map(allPolicies.map(policy => [policy.name, policy]))
  for (const [policyName, scope] of Object.entries(policies)) {
    if (scope === null) continue
    const declared = byName.get(policyName)?.scopeOptions
    if (!Array.isArray(declared)) continue
    if (!declared.some(option => option.name === scope)) {
      const known = declared.map(option => option.name).join(', ') || '(none)'
      throw new Error(
        `[rbac] seedGroups: group "${group}" grants policy "${policyName}" with unknown scope "${scope}" — declared scopeOptions: ${known}.`,
      )
    }
  }
}

function normalize(
  input: GroupPoliciesInput,
  allPolicies: { name: string }[],
): Record<string, string | null> {
  if (input === 'all') return Object.fromEntries(allPolicies.map(policy => [policy.name, null]))
  if (Array.isArray(input)) return Object.fromEntries(input.map(name => [name, null]))
  return input
}
