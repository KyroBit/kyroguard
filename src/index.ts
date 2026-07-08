/** @kyrobit/kyroguard — framework-agnostic core entry; integrations live at subpaths. */

import { GuardEngine } from './core/engine.js'
import { MisconfiguredError } from './core/errors.js'
import { collectScopes } from './core/scope.js'
import { backfillGroupDependencies, syncPolicies } from './core/sync.js'
import { seedGroups } from './core/seed-groups.js'
import { memoryCache } from './cache/memory.js'
import { inProcessBus } from './cache/bus.js'
import type { Policy, ResourceDefinition } from './core/policy.js'
import type { GroupsDefinition } from './core/seed-groups.js'
import type {
  DecisionHook,
  QualifiedPolicyName,
  ResourceRef,
  Subject,
} from './core/types.js'
import type { CacheHook, InvalidationBus, PolicyCache } from './cache/types.js'
import type { OwnershipEntry, StorageAdapter } from './storage/contract.js'

// ── Public API ────────────────────────────────────────────────────────────────

export interface CreateGuardOptions {
  adapter: StorageAdapter
  /** Resource definitions — source of the scope registry and tracking config. */
  resources?: ResourceDefinition[]
  /** Shorthand for a single guard-only resource definition. */
  policies?: Policy[]
  /** Group (role) definitions, seeded by guard.sync() after policies. */
  groups?: GroupsDefinition
  /** Policy cache. Default: bounded in-memory LRU (30s TTL). `false` disables caching. */
  cache?: PolicyCache | false
  /** TTL for the default memory cache. Ignored when `cache` is provided. */
  cacheTtlMs?: number
  /** Max entries for the default memory cache. Ignored when `cache` is provided. */
  cacheMaxEntries?: number
  /** Cross-instance invalidation. Default: in-process bus. */
  invalidationBus?: InvalidationBus
  /** Db handle passed through to scope checks (use the tracked db if you have one). */
  db?: unknown
  /** is_super bypasses policy checks. Default true. */
  superBypass?: boolean
  /** Audit hook — fires on every allow/deny decision. */
  onDecision?: DecisionHook
  /** Metrics hook — cache hits/misses/invalidations. */
  onCacheEvent?: CacheHook
}

/** The kyroguard instance apps create once and hand to a framework integration. */
export interface Guard {
  readonly engine: GuardEngine
  readonly adapter: StorageAdapter
  readonly resources: ResourceDefinition[]
  /** UNQUALIFIED policy name → owning resource; guards resolve the filter target through this. */
  readonly resourceForPolicy: ReadonlyMap<string, ResourceDefinition>

  /** Programmatic `npx kyroguard sync`. The explicit resources form does not touch groups. */
  sync(): Promise<void>
  sync(domain: string): Promise<void>
  sync(resources: ResourceDefinition[], domain?: string): Promise<void>
  /** Seed policy groups (replace-all per group). */
  seedGroups(groups: GroupsDefinition, options?: { domain?: string; allPolicies?: { name: string }[] }): Promise<void>

  /** Low-level assignment API — takes FULLY-QUALIFIED policy names and explicit coordinates. */
  admin: {
    assignGroup(subject: AdminSubjectRef, group: string): Promise<void>
    removeGroup(subject: AdminSubjectRef, group: string): Promise<void>
    assignPolicy(subject: AdminSubjectRef, policy: QualifiedPolicyName, scope?: string): Promise<void>
    removePolicy(subject: AdminSubjectRef, policy: QualifiedPolicyName): Promise<void>
  }

  /** Portable ownership API — works on every storage backend. Records relation 'owner'. */
  ownership: {
    record(owner: Subject | string, resource: ResourceRef, at?: { domain?: string; tenantId?: string }): Promise<void>
    isOwner(ownerId: string, resource: ResourceRef): Promise<boolean>
    remove(resource: ResourceRef): Promise<void>
    /** One-shot extra columns for the next tracked insert in this request. */
    addExtra(extra: Record<string, unknown>): void
  }

  /** Relation-based access API over the same store — default relation 'granted'. */
  access: {
    grant(
      userId: string,
      resource: ResourceRef,
      options?: { relation?: string; domain?: string; tenantId?: string },
    ): Promise<void>
    revoke(userId: string, resource: ResourceRef, relation?: string): Promise<void>
    list(resource: ResourceRef): Promise<OwnershipEntry[]>
  }

  cache: {
    invalidateSubject(subjectId: string): Promise<void>
    clear(): Promise<void>
  }

  /** Detach bus subscriptions (graceful shutdown / tests). */
  dispose(): void
}

export interface AdminSubjectRef {
  subjectId: string
  domain?: string
  tenantId?: string
}

export function createGuard(options: CreateGuardOptions): Guard {
  const resources = [...(options.resources ?? [])]
  if (options.policies?.length) {
    resources.push({ type: 'policy', policies: options.policies })
  }
  const scopes = collectScopes(resources)

  const resourceForPolicy = new Map<string, ResourceDefinition>()
  for (const resource of resources) {
    for (const policy of resource.policies) {
      if (!resourceForPolicy.has(policy.name)) resourceForPolicy.set(policy.name, resource)
    }
  }

  const cache =
    options.cache === false
      ? null
      : (options.cache ??
        memoryCache({
          maxEntries: options.cacheMaxEntries ?? 10_000,
          ttlMs: options.cacheTtlMs ?? 30_000,
        }))

  const bus = options.invalidationBus ?? inProcessBus()

  const engine = new GuardEngine({
    adapter: options.adapter,
    scopes,
    cache,
    bus,
    db: options.db,
    superBypass: options.superBypass,
    onDecision: options.onDecision,
    onCacheEvent: options.onCacheEvent,
  })

  const normalize = (subject: AdminSubjectRef) => ({
    subjectId: subject.subjectId,
    domain: subject.domain ?? '',
    tenantId: subject.tenantId ?? '',
  })

  return {
    engine,
    adapter: options.adapter,
    resources,
    resourceForPolicy,

    sync: async (resourcesOrDomain?: ResourceDefinition[] | string, domain?: string) => {
      const explicit = Array.isArray(resourcesOrDomain)
      const res = explicit ? resourcesOrDomain : resources
      const domainName = explicit ? domain : resourcesOrDomain
      await options.adapter.ensureSchema?.()
      await syncPolicies(options.adapter, res, domainName)
      if (!explicit && options.groups) {
        await seedGroups(
          options.adapter,
          options.groups,
          resources.flatMap(resource => resource.policies),
          domainName,
        )
        await backfillGroupDependencies(options.adapter, res, domainName)
      }
    },
    seedGroups: (groups, seedOptions) =>
      seedGroups(
        options.adapter,
        groups,
        seedOptions?.allPolicies ?? resources.flatMap(resource => resource.policies),
        seedOptions?.domain,
      ),

    admin: {
      assignGroup: (subject, group) => engine.assignGroup(normalize(subject), group),
      removeGroup: (subject, group) => engine.removeGroup(normalize(subject), group),
      assignPolicy: (subject, policy, scope) => engine.assignPolicy(normalize(subject), policy, scope),
      removePolicy: (subject, policy) => engine.removePolicy(normalize(subject), policy),
    },

    ownership: {
      record: (owner, resource, at) => {
        const ownerId = typeof owner === 'string' ? owner : owner.id
        const subject = typeof owner === 'string' ? undefined : owner
        return options.adapter.recordOwnership([
          {
            resourceType: resource.type,
            resourceId: resource.id,
            ownerId,
            relation: 'owner',
            domain: at?.domain ?? (subject?.domain as string | undefined) ?? '',
            tenantId: at?.tenantId ?? (subject?.tenant_id as string | undefined) ?? '',
          },
        ])
      },
      isOwner: (ownerId, resource) => options.adapter.isOwner(ownerId, resource),
      remove: resource => options.adapter.removeOwnership(resource),
      addExtra: extra => engine.store.addExtra(extra),
    },

    access: {
      grant: (userId, resource, accessOptions) =>
        options.adapter.recordOwnership([
          {
            resourceType: resource.type,
            resourceId: resource.id,
            ownerId: userId,
            relation: accessOptions?.relation ?? 'granted',
            domain: accessOptions?.domain ?? '',
            tenantId: accessOptions?.tenantId ?? '',
          },
        ]),
      revoke: async (userId, resource, relation) => {
        if (!options.adapter.removeAccess) {
          throw new MisconfiguredError(
            `[kyroguard] Adapter "${options.adapter.id}" does not implement removeAccess — implement it to use guard.access.`,
          )
        }
        await options.adapter.removeAccess(userId, resource, relation)
      },
      list: async resource => {
        if (!options.adapter.getAccess) {
          throw new MisconfiguredError(
            `[kyroguard] Adapter "${options.adapter.id}" does not implement getAccess — implement it to use guard.access.`,
          )
        }
        return options.adapter.getAccess(resource)
      },
    },

    cache: {
      invalidateSubject: id => engine.invalidateSubject(id),
      clear: () => engine.clearCache(),
    },

    dispose: () => engine.dispose(),
  }
}

// ── Re-exports (the whole public core surface) ────────────────────────────────

export { Policy } from './core/policy.js'
export type { ResourceDefinition } from './core/policy.js'
export { Scope, collectScopes } from './core/scope.js'
export type {
  ScopeCheckFn,
  ScopeCheckContext,
  ScopeFilterFn,
  ScopeFilterContext,
  ScopeFilterResult,
} from './core/scope.js'
export {
  GuardError,
  UnauthenticatedError,
  PolicyDeniedError,
  ScopeDeniedError,
  ResourceNotFoundError,
  MisconfiguredError,
} from './core/errors.js'
export type { AccessDeniedReason, GuardErrorBody, GuardErrorCode } from './core/errors.js'
export { GuardEngine, mergeGrants } from './core/engine.js'
export type { EngineOptions, AuthorizeOptions } from './core/engine.js'
export { SubjectStore } from './core/subject-store.js'
export type { RequestStore } from './core/subject-store.js'
export { backfillGroupDependencies, syncPolicies } from './core/sync.js'
export { seedGroups } from './core/seed-groups.js'
export type { GroupsDefinition, GroupDefinition, GroupPoliciesInput } from './core/seed-groups.js'
export { defineConfig } from './core/config.js'
export type { GuardConfig, DomainConfig } from './core/config.js'
export { qualifyPolicyName, toSubjectRef, normalizeSentinel } from './core/types.js'
export type {
  AnyPolicyName,
  Awaitable,
  DecisionEvent,
  DecisionHook,
  FilterResult,
  PolicyMap,
  DomainName,
  DomainPolicyName,
  QualifiedPolicyName,
  GuardTypes,
  ResourceRef,
  Subject,
  SubjectInput,
  SubjectRef,
} from './core/types.js'
// Re-exported so CLI-generated schema files don't need a direct cuid2 dependency.
export { createId } from '@paralleldrive/cuid2'
export { UnknownPolicyError, UnknownScopeError } from './storage/contract.js'
export type {
  AdapterCapabilities,
  GroupPolicyEntry,
  GroupRecord,
  ListFilters,
  OwnershipEntry,
  PolicyDefinitionRow,
  PolicyGrant,
  PolicyRecord,
  StorageAdapter,
} from './storage/contract.js'
export type {
  CacheEvent,
  CacheHook,
  InvalidationBus,
  InvalidationEvent,
  PolicyCache,
  PolicyCacheKey,
} from './cache/types.js'
