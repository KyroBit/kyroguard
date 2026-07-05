import type { StorageAdapter } from '../storage/contract.js'

/**
 * rbac.config.ts shape. The adapter factory is lazy so commands that don't
 * need a database (`rbac generate`) never open a connection, and the CLI
 * itself never imports a driver — the user's config does.
 */
export interface RbacConfig {
  adapter: () => Promise<StorageAdapter> | StorageAdapter
  portals: PortalConfig[]
  typegen?: {
    /** Output path for the generated declaration file. Default './rbac.d.ts'. */
    output?: string
  }
}

export interface PortalConfig {
  /** Portal name; omit or '' for a portal-less (single-app) setup. */
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
