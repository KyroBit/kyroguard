import { resolve } from 'node:path'
import { backfillGroupDependencies, syncPolicies } from '../../core/sync.js'
import { seedGroups } from '../../core/seed-groups.js'
import { loadModuleExport } from '../load-config.js'
import { generateTypes } from '../typegen.js'
import { loadDomainResources } from './generate.js'
import type { DomainTypeInfo } from '../typegen.js'
import type { RbacConfig } from '../../core/config.js'
import type { GroupsDefinition } from '../../core/seed-groups.js'
import type { StorageAdapter } from '../../storage/contract.js'

export async function run(config: RbacConfig, baseDir: string): Promise<void> {
  let adapter: StorageAdapter | undefined
  try {
    adapter = await config.adapter()
    await adapter.ensureSchema?.()

    const domains: DomainTypeInfo[] = []
    for (const domain of config.domains) {
      const domainName = domain.name ?? ''
      const resources = await loadDomainResources(baseDir, domain)
      const allPolicies = resources.flatMap(resource => resource.policies)

      await syncPolicies(adapter, resources, domainName, { logger: console.log })

      if (domain.groups) {
        const groups = await loadGroups(resolve(baseDir, domain.groups))
        await seedGroups(adapter, groups, allPolicies, domainName)
        console.log(
          `[rbac] Seeded ${Object.keys(groups).length} groups${domainName ? ` for domain "${domainName}"` : ''}.`,
        )
        // Seeding is replace-all per group (S8), which wipes the dependencies
        // syncPolicies just filled — run the back-fill again so they stick.
        await backfillGroupDependencies(adapter, resources, domainName, { logger: console.log })
      }

      domains.push({ name: domainName, policyNames: allPolicies.map(policy => policy.name) })
    }

    const output = resolve(baseDir, config.typegen?.output ?? './rbac.d.ts')
    await generateTypes(domains, output)
    console.log(`[rbac] Wrote ${output}`)
  } catch (error) {
    console.error(`[rbac] sync failed: ${messageOf(error)}`)
    if (isMissingTableError(error)) {
      console.error(
        '[rbac] The rbac tables do not exist yet — run your migrations first (drizzle-kit migrate, prisma migrate dev, or your migration tool).',
      )
    }
    process.exitCode = 1
  } finally {
    await adapter?.close?.().catch(() => {})
  }
}

async function loadGroups(path: string): Promise<GroupsDefinition> {
  const loaded = await loadModuleExport<unknown>(path, ['groups'])
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new Error(
      `[rbac] ${path} must export a GroupsDefinition object (as \`groups\` or the default export).`,
    )
  }
  return loaded as GroupsDefinition
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** pg 42P01, mysql ER_NO_SUCH_TABLE, sqlite "no such table" (S18). */
function isMissingTableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  if (code === '42P01' || code === 'ER_NO_SUCH_TABLE') return true
  return /(relation|table|collection)\b.*\b(does not|doesn't) exist|no such table/i.test(
    error.message,
  )
}
