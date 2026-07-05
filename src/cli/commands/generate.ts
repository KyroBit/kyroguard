import { resolve } from 'node:path'
import { loadModuleExport } from '../load-config.js'
import { generateTypes } from '../typegen.js'
import type { DomainTypeInfo } from '../typegen.js'
import type { DomainConfig, RbacConfig } from '../../core/config.js'
import type { Policy, ResourceDefinition } from '../../core/policy.js'

/** Typegen only — never calls the adapter, never opens a database. */
export async function run(config: RbacConfig, baseDir: string): Promise<void> {
  const domains: DomainTypeInfo[] = []
  for (const domain of config.domains) {
    const resources = await loadDomainResources(baseDir, domain)
    domains.push({
      name: domain.name ?? '',
      policyNames: resources.flatMap(resource => resource.policies.map(policy => policy.name)),
    })
  }

  const output = resolve(baseDir, config.typegen?.output ?? './rbac.d.ts')
  await generateTypes(domains, output)
  console.log(`[rbac] Wrote ${output}`)
}

export async function loadDomainResources(
  baseDir: string,
  domain: DomainConfig,
): Promise<ResourceDefinition[]> {
  const path = resolve(baseDir, domain.policies)
  const loaded = await loadModuleExport<unknown>(path, ['resources', 'policies'])
  if (!Array.isArray(loaded)) {
    throw new Error(
      `[rbac] ${path} must export a ResourceDefinition[] or Policy[] (as \`resources\`, \`policies\` or the default export).`,
    )
  }
  // A plain Policy[] — the same shorthand createRbac({ policies }) accepts —
  // is wrapped into a single guard-only resource definition.
  if (loaded.length > 0 && loaded.every(isPolicyLike)) {
    return [{ type: 'policy', policies: loaded }]
  }
  if (
    loaded.some(entry => typeof entry !== 'object' || entry === null || !Array.isArray((entry as ResourceDefinition).policies))
  ) {
    throw new Error(
      `[rbac] ${path} must export a ResourceDefinition[] or Policy[] (as \`resources\`, \`policies\` or the default export).`,
    )
  }
  return loaded as ResourceDefinition[]
}

/** A Policy has a `name` and, unlike a ResourceDefinition, no `policies` array. */
function isPolicyLike(entry: unknown): entry is Policy {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as { name?: unknown }).name === 'string' &&
    (entry as { policies?: unknown }).policies === undefined
  )
}
