import type { Awaitable, ResourceRef, Subject } from './types.js'
import type { ResourceDefinition } from './policy.js'
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

/** Passed to the filter half. Everything a filter needs to stay resource-generic. */
export interface ScopeFilterContext extends ScopeCheckContext {
  /** The registered resource being listed. */
  resource: ResourceDefinition
}

/**
 * The list-path decision for one grant's scope: `true` = no row restriction,
 * `false` = contributes nothing (fail closed), `{ where }` = a native
 * fragment for the active backend.
 */
export type ScopeFilterResult = boolean | { where: unknown }

export type ScopeFilterFn = (
  subject: Subject,
  ctx: ScopeFilterContext,
) => Awaitable<ScopeFilterResult>

/** A named row-level check, run when the resolved grant carries a scope. */
export class Scope {
  constructor(
    readonly name: string,
    readonly label: string,
    readonly check: ScopeCheckFn,
    /** List-path compilation. Omit for condition-only scopes — check(subject, null, ctx) is used. */
    readonly filter?: ScopeFilterFn,
  ) {
    // 'all' is the reserved unrestricted-grant marker — a scope by that name could never be granted.
    if (name === 'all') {
      throw new Error(`[kyroguard] Scope: the name 'all' is reserved — it marks an unrestricted grant.`)
    }
  }

  /** Built-in ownership scope backed by the adapter's ownership store; fails closed without a resource. */
  static owned(name = 'owned', label = 'Owned by the user'): Scope {
    return new Scope(
      name,
      label,
      (subject, resource, ctx) =>
        resource ? ctx.adapter.isOwner(subject.id, resource) : false,
      (subject, ctx) => {
        const support = ctx.adapter.listFilters
        if (!support) return false
        return support.owned(subject.id, ctx.resource, ctx.db)
      },
    )
  }

  /** Built-in tenant scope over the access store; fails closed without a resource or a tenant. */
  static inTenant(name = 'in-tenant', label = 'In the subject tenant'): Scope {
    return new Scope(
      name,
      label,
      async (subject, resource, ctx) => {
        if (!resource || !ctx.adapter.getAccess) return false
        const entries = await ctx.adapter.getAccess(resource)
        // '' is the no-tenant sentinel — it must never match '' rows.
        return entries.some(
          entry => entry.tenantId === subject.tenant_id && entry.tenantId !== '',
        )
      },
      (subject, ctx) => {
        const support = ctx.adapter.listFilters
        if (!support) return false
        const tenantId = subject.tenant_id
        if (typeof tenantId !== 'string' || tenantId === '') return false
        return support.inTenant(tenantId, ctx.resource, ctx.db)
      },
    )
  }

  /** Built-in grant scope: matches relation-'granted' access entries; fails closed without a resource. */
  static granted(name = 'granted', label = 'Granted to the user'): Scope {
    return new Scope(
      name,
      label,
      async (subject, resource, ctx) => {
        if (!resource || !ctx.adapter.getAccess) return false
        const entries = await ctx.adapter.getAccess(resource)
        return entries.some(
          entry => entry.ownerId === subject.id && entry.relation === 'granted',
        )
      },
      (subject, ctx) => {
        const support = ctx.adapter.listFilters
        if (!support) return false
        return support.granted(subject.id, ctx.resource, ctx.db)
      },
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
