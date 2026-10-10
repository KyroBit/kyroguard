import type { Awaitable, Subject } from './types.js'
import type { ResourceDefinition } from './policy.js'
import type { StorageAdapter } from '../storage/contract.js'

export interface ScopeContext {
  /** The db handle passed to createGuard (scoped or raw) — untyped by design. */
  db: unknown
  /** The storage adapter, for a scope that needs to read grants or policies. */
  adapter: StorageAdapter
  /** The registered resource being queried. */
  resource: ResourceDefinition
}

/**
 * What a scope decides: `true` = every row matches, `false` = none do (fail
 * closed), `{ where }` = a native fragment for the active backend.
 */
export type ScopeResult = boolean | { where: unknown }

export type ScopeFn = (subject: Subject, ctx: ScopeContext) => Awaitable<ScopeResult>

/** Columns a row created under this grant must carry. */
export type ScopeInsertFn = (
  subject: Subject,
  ctx: ScopeContext,
) => Awaitable<Record<string, unknown>>

export interface ScopeDefinition {
  match: ScopeFn
  insert?: ScopeInsertFn
}

/**
 * A named condition on a permission, written against the consumer's own tables.
 * `match` compiles to a fragment the integration adds to every query for the
 * resource — reads, updates and deletes alike — so a row it excludes cannot be
 * reached at all. A request naming such a row finds nothing and answers 404;
 * there is no separate single-row check.
 */
export class Scope {
  readonly match: ScopeFn
  readonly insert?: ScopeInsertFn

  constructor(
    readonly name: string,
    readonly label: string,
    definition: ScopeFn | ScopeDefinition,
  ) {
    // 'all' is the reserved unrestricted-grant marker — a scope by that name could never be granted.
    if (name === 'all') {
      throw new Error(`[kyroguard] Scope: the name 'all' is reserved — it marks an unrestricted grant.`)
    }
    if (typeof definition === 'function') {
      this.match = definition
    } else {
      this.match = definition.match
      this.insert = definition.insert
    }
  }
}

/** Collect the scope registry from resource definitions. */
export function collectScopes(resources: Iterable<{ policies: { scopeOptions: Scope[] }[] }>): Map<string, Scope> {
  const registry = new Map<string, Scope>()
  for (const resource of resources) {
    for (const policy of resource.policies) {
      for (const scope of policy.scopeOptions) {
        registry.set(scope.name, scope)
      }
    }
  }
  return registry
}
