import type { StorageAdapter } from '../storage/contract.js'

/**
 * rbac.config.ts shape. The adapter factory is lazy so commands that don't
 * need a database (`rbac generate`) never open a connection, and the CLI
 * itself never imports a driver — the user's config does.
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
