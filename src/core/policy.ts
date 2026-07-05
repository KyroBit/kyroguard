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

  /**
   * The label is derived from the name when omitted:
   * 'sales.create' → "Create sales", 'blog-category.read' → "Read blog category".
   * Both forms are equivalent:
   *   new Policy('sales.void', 'Void sales', ['sales.view'], [Scope.owned()])
   *   new Policy('sales.void', { dependsOn: ['sales.view'], scopeOptions: [Scope.owned()] })
   */
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

/** 'sales.create' → "Create sales"; 'dashboard' → "Dashboard". */
function humanize(name: string): string {
  const segments = name.split('.')
  const action = (segments.pop() ?? name).replace(/-/g, ' ')
  if (segments.length === 0) return capitalize(action)
  const resource = segments.join(' ').replace(/-/g, ' ')
  return `${capitalize(action)} ${resource}`
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Links one resource (a Drizzle table, a Mongoose model, or just a type name)
 * to its policies. `table` is optional: storage-level features (ownership
 * auto-tracking, query scoping) need it; guard-only usage does not.
 */
export interface ResourceDefinition {
  type: string
  policies: Policy[]
  /** Drizzle table or Mongoose model — consumed by trackedDb / the plugin. */
  table?: unknown
  /** domain name → policy name → scope names (query-scoping config). */
  domains?: Record<string, PolicyScopeMap>
}

export type PolicyScopeMap = Record<string, string[]>
