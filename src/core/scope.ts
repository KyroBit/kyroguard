import type { Awaitable, ResourceRef, Subject } from './types.js'
import type { StorageAdapter } from '../storage/contract.js'

export interface ScopeCheckContext {
  /** The db handle passed to createRbac (tracked or raw) — untyped by design. */
  db: unknown
  /** The storage adapter — powers portable checks like Scope.owned(). */
  adapter: StorageAdapter
}

/**
 * The scope decision. `resource` is null when the guard has no resource
 * resolver — condition scopes (time, subject attributes) decide anyway;
 * row scopes must fail closed on null.
 */
export type ScopeCheckFn = (
  subject: Subject,
  resource: ResourceRef | null,
  ctx: ScopeCheckContext,
) => Awaitable<boolean>

/** A named row-level check, run when the resolved grant carries a scope. */
export class Scope {
  constructor(
    readonly name: string,
    readonly label: string,
    readonly check: ScopeCheckFn,
  ) {}

  /** Built-in ownership scope backed by the adapter's ownership store; fails closed without a resource. */
  static owned(name = 'owned', label = 'Owned by the user'): Scope {
    return new Scope(name, label, (subject, resource, ctx) =>
      resource ? ctx.adapter.isOwner(subject.id, resource) : false,
    )
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
