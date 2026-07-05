import type { Scope } from './scope.js'

export class Policy {
  readonly label: string

  constructor(
    readonly name: string,
    label?: string,
    readonly dependsOn: string[] = [],
    readonly scopeOptions: Scope[] = [],
  ) {
    this.label = label ?? humanize(name)
  }
}

function humanize(name: string): string {
  const last = name.split('.').pop() ?? name
  return last.replace(/-/g, ' ')
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
