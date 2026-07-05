import type { Awaitable, ResourceRef, Subject } from './types.js'
import type { StorageAdapter } from '../storage/contract.js'

export interface ScopeCheckContext {
  /** The db handle passed to createRbac (tracked or raw) — untyped by design. */
  db: unknown
  /** The storage adapter — powers portable checks like Scope.owned(). */
  adapter: StorageAdapter
}

export type ScopeCheckFn = (
  subject: Subject,
  resource: ResourceRef,
  ctx: ScopeCheckContext,
) => Awaitable<boolean>

/**
 * A named row-level check. When a grant carries a scope, the guard resolves
 * the target resource and the scope's check decides allow/deny.
 */
export class Scope {
  constructor(
    readonly name: string,
    readonly label: string,
    readonly check: ScopeCheckFn,
  ) {}

  /**
   * Built-in ownership scope, backed by the adapter's ownership store —
   * identical behavior on every storage backend.
   */
  static owned(name = 'owned', label = 'Owned by the user'): Scope {
    return new Scope(name, label, (subject, resource, ctx) =>
      ctx.adapter.isOwner(subject.id, resource),
    )
  }
}

/** Collect the scope registry from resource definitions (replaces the v0 RBAC_SCOPES symbol). */
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
