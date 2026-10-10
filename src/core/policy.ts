import type { Scope } from './scope.js'

export interface PolicyOptions {
  label?: string
  dependsOn?: string[]
  scopeOptions?: Scope[]
  /**
   * The scope a blanket grant gets for this policy — `is_super`, and a group
   * whose `policies` is `'all'`. Neither names a scope, so without this a
   * blanket grant would reach every row. Redundant when `scopeOptions` holds
   * exactly one entry: that one is used.
   */
  superScope?: Scope
}

export class Policy {
  readonly label: string
  readonly dependsOn: string[]
  readonly scopeOptions: Scope[]
  readonly superScope?: Scope

  constructor(name: string, options?: PolicyOptions)
  constructor(name: string, label?: string, dependsOn?: string[], scopeOptions?: Scope[])
  constructor(
    readonly name: string,
    labelOrOptions?: string | PolicyOptions,
    dependsOn: string[] = [],
    scopeOptions: Scope[] = [],
  ) {
    if (typeof labelOrOptions === 'object' && labelOrOptions !== null) {
      this.label = labelOrOptions.label ?? humanize(name)
      this.dependsOn = labelOrOptions.dependsOn ?? []
      this.scopeOptions = labelOrOptions.scopeOptions ?? []
      this.superScope = labelOrOptions.superScope
    } else {
      this.label = labelOrOptions ?? humanize(name)
      this.dependsOn = dependsOn
      this.scopeOptions = scopeOptions
    }
  }
}

function humanize(name: string): string {
  const action = (name.split('.').pop() ?? name).replace(/-/g, ' ')
  return capitalize(action)
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Structurally matches Policy; seedGroups holds only names, the engine holds Scopes. */
export interface BlanketScopeInput {
  name: string
  scopeOptions?: readonly { name: string }[]
  superScope?: { name: string }
}

/**
 * The scope a blanket grant reaches with — `is_super`, and a group whose
 * `policies` is `'all'`. Stated outright, or the single declared option. Several
 * options with nothing stated is ambiguous: the policy has to say which one
 * wholesale access means. `null` means unrestricted, which is what a policy
 * declaring no scope at all is asking for.
 */
export function blanketScopeName(policy: BlanketScopeInput): string | null {
  if (policy.superScope) return policy.superScope.name
  const options = policy.scopeOptions ?? []
  if (options.length === 0) return null
  if (options.length === 1) return options[0]!.name
  throw new Error(
    `[kyroguard] Policy "${policy.name}" declares ${options.length} scopeOptions, so wholesale ` +
      `access is ambiguous — set superScope to the one a blanket grant means.`,
  )
}

/** Links one resource to its policies; `table` is only needed for storage-level features. */
export interface ResourceDefinition {
  type: string
  policies: Policy[]
  /** Drizzle table or Mongoose model — consumed by scopedDb / the plugin. */
  table?: unknown
}
