import type { StorageAdapter } from '../storage/contract.js'

/**
 * rbac.config.ts shape. The adapter factory is lazy — the user's config owns
 * the driver imports, never the CLI.
 */
export interface RbacConfig {
  adapter: () => Promise<StorageAdapter> | StorageAdapter
  domains: DomainConfig[]
  typegen?: {
    /** Output path for the generated declaration file. Default './rbac.d.ts'. */
    output?: string
  }
}

export interface DomainConfig {
  /** Domain name; omit or '' for a single-app setup with no domain. */
  name?: string
  /** Path to the module exporting `resources` (ResourceDefinition[]). */
  policies: string
  /** Optional path to the module exporting `groups` (GroupsDefinition). */
  groups?: string
}

/** Typed identity — gives rbac.config.ts full autocompletion. */
export function defineConfig(config: RbacConfig): RbacConfig {
  return config
}
