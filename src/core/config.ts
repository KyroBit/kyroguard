import type { StorageAdapter } from '../storage/contract.js'

/**
 * kyroguard.config.ts shape. The adapter factory is lazy — the user's config owns
 * the driver imports, never the CLI.
 */
export interface GuardConfig {
  adapter: () => Promise<StorageAdapter> | StorageAdapter
  /**
   * Explicit domain entries, or a directory to scan by convention:
   * flat `policies.ts` / `groups.ts` for a single (unnamed) domain, or
   * `policies/<name>.ts` per domain with `groups/<name>.ts` attached when
   * present. Adding a domain is adding a file.
   */
  domains: DomainConfig[] | string
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
export function defineConfig(config: GuardConfig): GuardConfig {
  return config
}
