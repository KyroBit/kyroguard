import type { RbacConfig } from '../../core/config.js'
import type { StorageAdapter } from '../../storage/contract.js'

export async function run(config: RbacConfig): Promise<void> {
  let adapter: StorageAdapter | undefined
  try {
    adapter = await config.adapter()
    const [policies, groups] = await Promise.all([adapter.listPolicies(), adapter.listGroups()])

    console.log(`adapter:      ${adapter.id}`)
    console.log(
      `capabilities: autoOwnershipTracking=${adapter.capabilities.autoOwnershipTracking} queryScoping=${adapter.capabilities.queryScoping}`,
    )
    console.log(`policies:     ${policies.length}`)
    console.log(`groups:       ${groups.length}`)
  } catch (error) {
    console.error(`[rbac] status failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  } finally {
    await adapter?.close?.().catch(() => {})
  }
}
