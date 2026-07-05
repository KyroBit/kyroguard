import type { Scope } from './scope.js'

export interface PolicyOptions {
  label?: string
  dependsOn?: string[]
  scopeOptions?: Scope[]
}

export class Policy {
  readonly label: string
  readonly dependsOn: string[]
  readonly scopeOptions: Scope[]

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

/** Links one resource to its policies; `table` is only needed for storage-level features. */
export interface ResourceDefinition {
  type: string
  policies: Policy[]
  /** Drizzle table or Mongoose model — consumed by trackedDb / the plugin. */
  table?: unknown
  /** domain name → policy name → scope names (query-scoping config). */
  domains?: Record<string, PolicyScopeMap>
}

export type PolicyScopeMap = Record<string, string[]>
