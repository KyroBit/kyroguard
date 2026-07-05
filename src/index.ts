/**
 * @kyrobit/rbac — framework-agnostic core.
 *
 * This entry imports nothing from Fastify, Express, Drizzle or Mongoose.
 * Framework and storage integrations live at subpaths:
 *   @kyrobit/rbac/fastify   @kyrobit/rbac/express
 *   @kyrobit/rbac/drizzle   @kyrobit/rbac/mongoose
 *   @kyrobit/rbac/cache     @kyrobit/rbac/testing
 */

import { RbacEngine } from './core/engine.js'
import { collectScopes } from './core/scope.js'
import { syncPolicies } from './core/sync.js'
import { seedGroups } from './core/seed-groups.js'
import { memoryCache } from './cache/memory.js'
import { inProcessBus } from './cache/bus.js'
import type { ResourceDefinition } from './core/policy.js'
import type { GroupsDefinition } from './core/seed-groups.js'
import type {
  DecisionHook,
  QualifiedPolicyName,
  ResourceRef,
  Subject,
} from './core/types.js'
import type { CacheHook, InvalidationBus, PolicyCache } from './cache/types.js'
import type { StorageAdapter } from './storage/contract.js'

// ── Public API ────────────────────────────────────────────────────────────────

export interface CreateRbacOptions {
  adapter: StorageAdapter
  /** Resource definitions — source of the scope registry and tracking config. */
  resources?: ResourceDefinition[]
  /**
   * Policy cache. Default: bounded in-memory LRU with a 30s TTL.
   * Pass `false` to disable caching entirely.
   */
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

/** The rbac instance apps create once and hand to a framework integration. */
export interface Rbac {
  readonly engine: RbacEngine
  readonly adapter: StorageAdapter
  readonly resources: ResourceDefinition[]

  /** Sync policies-as-code into storage (also available via `rbac sync`). */
  sync(resources: ResourceDefinition[], portal?: string): Promise<void>
  /** Seed policy groups (replace-all per group). */
  seedGroups(groups: GroupsDefinition, allPolicies?: { name: string }[], portal?: string): Promise<void>

  /**
   * Low-level assignment API. Takes FULLY-QUALIFIED policy names and explicit
   * portal/context. Portal instances (framework layer) offer the auto-prefixed
   * ergonomic form — prefer those in app code.
   */
  admin: {
    assignGroup(subject: AdminSubjectRef, group: string): Promise<void>
    removeGroup(subject: AdminSubjectRef, group: string): Promise<void>
    assignPolicy(subject: AdminSubjectRef, policy: QualifiedPolicyName, scope?: string | null): Promise<void>
    removePolicy(subject: AdminSubjectRef, policy: QualifiedPolicyName): Promise<void>
  }

  /** Portable ownership API — works on every storage backend. */
  ownership: {
    record(owner: Subject | string, resource: ResourceRef, context?: { portal?: string; contextId?: string }): Promise<void>
    isOwner(ownerId: string, resource: ResourceRef): Promise<boolean>
    remove(resource: ResourceRef): Promise<void>
    /** One-shot extra columns for the next tracked insert in this request. */
    addExtra(extra: Record<string, unknown>): void
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
  portal?: string
  contextId?: string
}

export function createRbac(options: CreateRbacOptions): Rbac {
  const resources = options.resources ?? []
  const scopes = collectScopes(resources)

  const cache =
    options.cache === false
      ? null
      : (options.cache ??
        memoryCache({
          maxEntries: options.cacheMaxEntries ?? 10_000,
          ttlMs: options.cacheTtlMs ?? 30_000,
        }))

  const bus = options.invalidationBus ?? inProcessBus()

  const engine = new RbacEngine({
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
    portal: subject.portal ?? '',
    contextId: subject.contextId ?? '',
  })

  return {
    engine,
    adapter: options.adapter,
    resources,

    sync: async (res, portal) => {
      await options.adapter.ensureSchema?.()
      return syncPolicies(options.adapter, res, portal)
    },
    seedGroups: (groups, allPolicies, portal) =>
      seedGroups(options.adapter, groups, allPolicies, portal),

    admin: {
      assignGroup: (subject, group) => engine.assignGroup(normalize(subject), group),
      removeGroup: (subject, group) => engine.removeGroup(normalize(subject), group),
      assignPolicy: (subject, policy, scope) => engine.assignPolicy(normalize(subject), policy, scope),
      removePolicy: (subject, policy) => engine.removePolicy(normalize(subject), policy),
    },

    ownership: {
      record: (owner, resource, context) => {
        const ownerId = typeof owner === 'string' ? owner : owner.id
        const subject = typeof owner === 'string' ? undefined : owner
        return options.adapter.recordOwnership([
          {
            resourceType: resource.type,
            resourceId: resource.id,
            ownerId,
            contextType: context?.portal ?? (subject?.portal as string | undefined) ?? '',
            contextId: context?.contextId ?? (subject?.context_id as string | undefined) ?? '',
          },
        ])
      },
      isOwner: (ownerId, resource) => options.adapter.isOwner(ownerId, resource),
      remove: resource => options.adapter.removeOwnership(resource),
      addExtra: extra => engine.store.addExtra(extra),
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
export type { ResourceDefinition, ContextPolicies } from './core/policy.js'
export { Scope, collectScopes } from './core/scope.js'
export type { ScopeCheckFn, ScopeCheckContext } from './core/scope.js'
export {
  RbacError,
  UnauthenticatedError,
  PolicyDeniedError,
  ScopeDeniedError,
  ResourceNotFoundError,
  MisconfiguredError,
} from './core/errors.js'
export type { RbacErrorCode } from './core/errors.js'
export { RbacEngine, mergeGrants } from './core/engine.js'
export type { EngineOptions, AuthorizeOptions } from './core/engine.js'
export { SubjectStore } from './core/subject-store.js'
export type { RequestStore } from './core/subject-store.js'
export { backfillGroupDependencies, syncPolicies } from './core/sync.js'
export { seedGroups } from './core/seed-groups.js'
export type { GroupsDefinition, GroupDefinition, GroupPoliciesInput } from './core/seed-groups.js'
export { defineConfig } from './core/config.js'
export type { RbacConfig, PortalConfig } from './core/config.js'
export { qualifyPolicyName, toSubjectRef, normalizeSentinel } from './core/types.js'
export type {
  AnyPolicyName,
  Awaitable,
  DecisionEvent,
  DecisionHook,
  PolicyMap,
  PortalName,
  PortalPolicyName,
  QualifiedPolicyName,
  RbacTypes,
  ResourceRef,
  Subject,
  SubjectInput,
  SubjectRef,
} from './core/types.js'
// Re-exported so CLI-generated schema files in user projects don't need a
// direct dependency on @paralleldrive/cuid2 (strict pnpm layouts).
export { createId } from '@paralleldrive/cuid2'
export { UnknownPolicyError } from './storage/contract.js'
export type {
  AdapterCapabilities,
  GroupPolicyEntry,
  GroupRecord,
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
