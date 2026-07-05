import { qualifyPolicyName } from './types.js'
import type { GroupPolicyEntry, StorageAdapter } from '../storage/contract.js'

/**
 * 'all' = every synced policy (requires allPolicies); string[] = those
 * policies unrestricted; Record = policy → scope (null = unrestricted).
 * Names are UNQUALIFIED — seedGroups qualifies them with the domain sentinel.
 */
export type GroupPoliciesInput = 'all' | string[] | Record<string, string | null>

export interface GroupDefinition {
  label: string
  description?: string
  policies: GroupPoliciesInput
}

export type GroupsDefinition = Record<string, GroupDefinition>

export async function seedGroups(
  adapter: StorageAdapter,
  groups: GroupsDefinition,
  allPolicies?: { name: string }[],
  domain?: string,
): Promise<void> {
  const domainSentinel = domain ?? ''

  for (const [name, def] of Object.entries(groups)) {
    if (def.policies === 'all' && !allPolicies) {
      throw new Error(
        `[rbac] seedGroups: group "${name}" uses policies: 'all' but no allPolicies array was passed as the third argument.`,
      )
    }

    const entries: GroupPolicyEntry[] = Object.entries(
      normalize(def.policies, allPolicies ?? []),
    ).map(([policyName, scope]) => ({
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

function normalize(
  input: GroupPoliciesInput,
  allPolicies: { name: string }[],
): Record<string, string | null> {
  if (input === 'all') return Object.fromEntries(allPolicies.map(policy => [policy.name, null]))
  if (Array.isArray(input)) return Object.fromEntries(input.map(name => [name, null]))
  return input
}
