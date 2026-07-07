import type { StorageAdapter } from '../storage/contract.js'

/**
 * kyroguard.config.ts shape. The adapter factory is lazy — the user's config owns
 * the driver imports, never the CLI.
 */
export interface KyroguardConfig {
  adapter: () => Promise<StorageAdapter> | StorageAdapter
  domains: DomainConfig[]
  typegen?: {
    /** Output path for the generated declaration file. Default './kyroguard.d.ts'. */
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

/** Typed identity — gives kyroguard.config.ts full autocompletion. */
export function defineConfig(config: KyroguardConfig): KyroguardConfig {
  return config
}
