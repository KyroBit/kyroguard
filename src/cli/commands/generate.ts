import { resolve } from 'node:path'
import { loadModuleExport } from '../load-config.js'
import { generateTypes } from '../typegen.js'
import type { PortalTypeInfo } from '../typegen.js'
import type { PortalConfig, RbacConfig } from '../../core/config.js'
import type { ResourceDefinition } from '../../core/policy.js'

/** Typegen only — never calls the adapter, never opens a database. */
export async function run(config: RbacConfig, baseDir: string): Promise<void> {
  const portals: PortalTypeInfo[] = []
  for (const portal of config.portals) {
    const resources = await loadPortalResources(baseDir, portal)
    portals.push({
      name: portal.name ?? '',
      policyNames: resources.flatMap(resource => resource.policies.map(policy => policy.name)),
    })
  }

  const output = resolve(baseDir, config.typegen?.output ?? './rbac.d.ts')
  await generateTypes(portals, output)
  console.log(`[rbac] Wrote ${output}`)
}

export async function loadPortalResources(
  baseDir: string,
  portal: PortalConfig,
): Promise<ResourceDefinition[]> {
  const path = resolve(baseDir, portal.policies)
  const loaded = await loadModuleExport<unknown>(path, ['resources', 'policies'])
  if (
    !Array.isArray(loaded) ||
    loaded.some(entry => typeof entry !== 'object' || entry === null || !Array.isArray((entry as ResourceDefinition).policies))
  ) {
    throw new Error(
      `[rbac] ${path} must export a ResourceDefinition[] (as \`resources\`, \`policies\` or the default export).`,
    )
  }
  return loaded as ResourceDefinition[]
}
