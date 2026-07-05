import { performance } from 'node:perf_hooks'
import {
  PolicyDeniedError,
  ResourceNotFoundError,
  ScopeDeniedError,
  UnauthenticatedError,
} from './errors.js'
import { policyCacheKey } from '../cache/key.js'
import { SubjectStore } from './subject-store.js'
import { normalizeSentinel, qualifyPolicyName, toSubjectRef } from './types.js'
import type {
  Awaitable,
  DecisionEvent,
  DecisionHook,
  FilterResult,
  PolicyMap,
  QualifiedPolicyName,
  ResourceRef,
  Subject,
  SubjectRef,
} from './types.js'
import type { ResourceDefinition } from './policy.js'
import type { CacheHook, InvalidationBus, PolicyCache } from '../cache/types.js'
import { UnknownScopeError } from '../storage/contract.js'
import type { PolicyGrant, StorageAdapter } from '../storage/contract.js'
import type { Scope } from './scope.js'

export interface EngineOptions {
  adapter: StorageAdapter
  scopes: Map<string, Scope>
  /** null disables caching entirely. */
  cache: PolicyCache | null
  bus: InvalidationBus
  /** The db handle handed to scope checks (tracked or raw). */
  db?: unknown
  /** is_super bypasses policy checks. Default true; disable per deployment policy. */
  superBypass?: boolean
  onDecision?: DecisionHook
  onCacheEvent?: CacheHook
}

export interface AuthorizeOptions {
  resource?: () => Awaitable<ResourceRef | null | undefined>
}

/** Framework-free engine: authorize() resolves (allow) or throws a typed RbacError (deny). */
export class RbacEngine {
  readonly store = new SubjectStore()

  private readonly adapter: StorageAdapter
  private readonly scopes: Map<string, Scope>
  private readonly policyCache: PolicyCache | null
  private readonly bus: InvalidationBus
  private readonly db: unknown
  private readonly superBypass: boolean
  private readonly onDecision?: DecisionHook
  private readonly onCacheEvent?: CacheHook
  private readonly unsubscribe: () => void

  constructor(options: EngineOptions) {
    this.adapter = options.adapter
    this.scopes = options.scopes
    this.policyCache = options.cache
    this.bus = options.bus
    this.db = options.db
    this.superBypass = options.superBypass ?? true
    this.onDecision = options.onDecision
    this.onCacheEvent = options.onCacheEvent

    this.unsubscribe = this.bus.subscribe(event => {
      if (!this.policyCache) return
      void (event.type === 'all'
        ? this.policyCache.clear()
        : this.policyCache.invalidateSubject(event.subjectId))
    })
  }

  /** Detach the bus subscription (tests, graceful shutdown). */
  dispose(): void {
    this.unsubscribe()
  }

  // ── Request context ─────────────────────────────────────────────────────────

  runWithRequestContext<T>(fn: () => T): T {
    return this.store.run(fn)
  }

  setRequestSubject(subject: Subject): void {
    this.store.setSubject(subject)
  }

  // ── Enforcement ─────────────────────────────────────────────────────────────

  /** Resolve the subject's policy map, via cache when enabled. */
  async getPolicyMap(ref: SubjectRef): Promise<{ map: PolicyMap; cacheHit: boolean }> {
    const key = policyCacheKey(ref.subjectId, ref.domain, ref.tenantId)

    if (this.policyCache) {
      const hit = await this.policyCache.get(key)
      if (hit) {
        this.emitCache({ type: 'hit', subjectId: ref.subjectId })
        return { map: hit, cacheHit: true }
      }
      this.emitCache({ type: 'miss', subjectId: ref.subjectId })
    }

    const grants = await this.adapter.getSubjectPolicies(ref)
    const map = mergeGrants(grants)

    if (this.policyCache) {
      await this.policyCache.set(key, map)
      this.emitCache({ type: 'set', subjectId: ref.subjectId })
    }
    return { map, cacheHit: false }
  }

  /** The decision procedure: resolves on allow, throws a typed RbacError on deny. */
  async authorize(
    subject: Subject | null | undefined,
    policy: QualifiedPolicyName,
    options?: AuthorizeOptions,
  ): Promise<void> {
    const startedAt = performance.now()

    if (!subject?.id) {
      this.emitDecision(subject, policy, 'deny', 'no-subject', null, false, startedAt)
      throw new UnauthenticatedError()
    }

    if (this.superBypass && subject.is_super === true) {
      this.emitDecision(subject, policy, 'allow', 'super', null, false, startedAt)
      return
    }

    const ref = toSubjectRef(subject)
    const { map, cacheHit } = await this.getPolicyMap(ref)

    if (!map.has(policy)) {
      this.emitDecision(subject, policy, 'deny', 'no-policy', null, cacheHit, startedAt)
      throw new PolicyDeniedError(policy)
    }

    const scopeNames = map.get(policy)!
    if (scopeNames === null) {
      this.emitDecision(subject, policy, 'allow', 'granted', null, cacheHit, startedAt)
      return
    }

    // Resolver and scope checks run with inAuthz set: their queries must see
    // the unfiltered table, so filtering wrappers stand down (isInAuthz).
    const prevInAuthz = this.store.isInAuthz()
    this.store.setInAuthz(true)
    try {
      // No resolver: the scopes decide on null (row-based scopes fail closed).
      // A resolver that finds nothing is a 404.
      let resource: ResourceRef | null = null
      if (options?.resource) {
        resource = (await options.resource()) ?? null
        if (!resource) {
          this.emitDecision(subject, policy, 'deny', 'resource-not-found', scopeNames[0] ?? null, cacheHit, startedAt)
          throw new ResourceNotFoundError()
        }
      }

      // Scopes OR together: the first passing scope allows. An unknown scope
      // name contributes a deny, never a bypass.
      const ctx = { db: this.db, adapter: this.adapter }
      for (const scopeName of scopeNames) {
        const scope = this.scopes.get(scopeName)
        if (!scope) continue
        if (await scope.check(subject, resource, ctx)) {
          this.emitDecision(subject, policy, 'allow', 'granted', scopeName, cacheHit, startedAt)
          return
        }
      }
    } finally {
      this.store.setInAuthz(prevInAuthz)
    }

    const deniedScope = scopeNames[0] ?? ''
    this.emitDecision(subject, policy, 'deny', 'scope-denied', deniedScope, cacheHit, startedAt)
    throw new ScopeDeniedError(policy, deniedScope)
  }

  /**
   * List-path decision procedure. Throws UnauthenticatedError for a missing
   * subject ONLY; every other outcome is a FilterResult.
   */
  async filterFor(
    subject: Subject | null | undefined,
    policy: QualifiedPolicyName,
    resource: ResourceDefinition,
  ): Promise<FilterResult> {
    const startedAt = performance.now()

    if (!subject?.id) {
      this.emitDecision(subject, policy, 'deny', 'no-subject', null, false, startedAt, 'list')
      throw new UnauthenticatedError()
    }

    if (this.superBypass && subject.is_super === true) {
      this.emitDecision(subject, policy, 'allow', 'super', null, false, startedAt, 'list')
      return { kind: 'all' }
    }

    const ref = toSubjectRef(subject)
    const { map, cacheHit } = await this.getPolicyMap(ref)

    if (!map.has(policy)) {
      this.emitDecision(subject, policy, 'deny', 'no-policy', null, cacheHit, startedAt, 'list')
      return { kind: 'none', reason: 'no-policy' }
    }

    const scopeNames = map.get(policy)!
    if (scopeNames === null) {
      this.emitDecision(subject, policy, 'allow', 'granted', null, cacheHit, startedAt, 'list')
      return { kind: 'all' }
    }

    const ctx = { db: this.db, adapter: this.adapter }
    const fragments: unknown[] = []
    const fragmentScopes: string[] = []
    // Filter building runs with inAuthz set for the same reason as authorize:
    // a filter half querying the db must not be auto-filtered itself.
    const prevInAuthz = this.store.isInAuthz()
    this.store.setInAuthz(true)
    try {
      for (const scopeName of scopeNames) {
        const scope = this.scopes.get(scopeName)
        if (!scope) {
          this.warnOnce(
            `unknown-scope:${scopeName}`,
            `[rbac] Grant references unknown scope "${scopeName}" — it contributes a deny on both paths.`,
          )
          continue
        }
        // A scope without a filter half folds through check(subject, null, ctx):
        // condition scopes decide once per request, row scopes fail closed.
        const result = scope.filter
          ? await scope.filter(subject, { ...ctx, resource })
          : await scope.check(subject, null, ctx)
        if (result === true) {
          this.emitDecision(subject, policy, 'allow', 'granted', scopeName, cacheHit, startedAt, 'list')
          return { kind: 'all' }
        }
        if (result === false) continue
        fragments.push(result.where)
        fragmentScopes.push(scopeName)
      }
    } finally {
      this.store.setInAuthz(prevInAuthz)
    }

    if (fragments.length === 0) {
      this.emitDecision(subject, policy, 'deny', 'scope-denied', scopeNames[0] ?? null, cacheHit, startedAt, 'list')
      return { kind: 'none', reason: 'scope-denied' }
    }

    if (fragments.length === 1) {
      this.emitDecision(subject, policy, 'allow', 'granted', fragmentScopes[0]!, cacheHit, startedAt, 'list')
      return { kind: 'where', where: fragments[0] }
    }

    const support = this.adapter.listFilters
    if (!support) {
      this.warnOnce(
        `unfilterable:${this.adapter.id}`,
        `[rbac] Adapter "${this.adapter.id}" has no listFilters — cannot OR-combine ${fragments.length} scope fragments; the list is empty.`,
      )
      this.emitDecision(subject, policy, 'deny', 'scope-denied', fragmentScopes.join(','), cacheHit, startedAt, 'list')
      return { kind: 'none', reason: 'unfilterable' }
    }

    this.emitDecision(subject, policy, 'allow', 'granted', fragmentScopes.join(','), cacheHit, startedAt, 'list')
    return { kind: 'where', where: support.or(fragments) }
  }

  /** Wrapper entry for automatic read filtering: resources without `list` opt out with 'all'. */
  async filterForResource(
    subject: Subject | null | undefined,
    resource: ResourceDefinition,
  ): Promise<FilterResult> {
    if (!resource.list) return { kind: 'all' }
    const policy = qualifyPolicyName(normalizeSentinel(subject?.domain), resource.list)
    return this.filterFor(subject, policy, resource)
  }

  // ── Mutations (invalidate + publish, always) ────────────────────────────────

  async assignGroup(ref: SubjectRef, groupName: string): Promise<void> {
    await this.adapter.assignGroup(ref, groupName)
    await this.invalidateSubject(ref.subjectId)
  }

  async removeGroup(ref: SubjectRef, groupName: string): Promise<void> {
    await this.adapter.removeGroup(ref, groupName)
    await this.invalidateSubject(ref.subjectId)
  }

  async assignPolicy(ref: SubjectRef, policyName: QualifiedPolicyName, scope?: string | null): Promise<void> {
    if (typeof scope === 'string') {
      const record = (await this.adapter.listPolicies()).find(policy => policy.name === policyName)
      if (record && !record.scopeOptions.includes(scope)) {
        throw new UnknownScopeError(policyName, scope)
      }
    }
    await this.adapter.assignPolicy(ref, policyName, scope)
    await this.invalidateSubject(ref.subjectId)
  }

  async removePolicy(ref: SubjectRef, policyName: QualifiedPolicyName): Promise<void> {
    await this.adapter.removePolicy(ref, policyName)
    await this.invalidateSubject(ref.subjectId)
  }

  // ── Cache control ───────────────────────────────────────────────────────────

  async invalidateSubject(subjectId: string): Promise<void> {
    if (this.policyCache) {
      await this.policyCache.invalidateSubject(subjectId)
      this.emitCache({ type: 'invalidate-subject', subjectId })
    }
    await this.bus.publish({ type: 'subject', subjectId })
  }

  async clearCache(): Promise<void> {
    if (this.policyCache) {
      await this.policyCache.clear()
      this.emitCache({ type: 'clear' })
    }
    await this.bus.publish({ type: 'all' })
  }

  // ── Accessors for the edges ─────────────────────────────────────────────────

  getAdapter(): StorageAdapter {
    return this.adapter
  }

  getDb(): unknown {
    return this.db
  }

  qualify(domain: string, policy: string): QualifiedPolicyName {
    return qualifyPolicyName(domain, policy)
  }

  private readonly warned = new Set<string>()

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    console.warn(message)
  }

  private emitDecision(
    subject: Subject | null | undefined,
    policy: QualifiedPolicyName,
    decision: DecisionEvent['decision'],
    reason: DecisionEvent['reason'],
    scope: string | null,
    cacheHit: boolean,
    startedAt: number,
    mode: DecisionEvent['mode'] = 'guard',
  ): void {
    if (!this.onDecision) return
    try {
      this.onDecision({
        subjectId: subject?.id ?? '',
        domain: (subject?.domain as string | undefined) ?? '',
        tenantId: (subject?.tenant_id as string | undefined) ?? '',
        policy,
        decision,
        reason,
        mode,
        scope,
        cacheHit,
        durationMs: performance.now() - startedAt,
      })
    } catch {
      // Observability must never affect authorization.
    }
  }

  private emitCache(event: Parameters<CacheHook>[0]): void {
    if (!this.onCacheEvent) return
    try {
      this.onCacheEvent(event)
    } catch {
      // Same rule as emitDecision.
    }
  }
}

/** Null scope (unrestricted) wins entirely; otherwise the deduped union of scope names in grant order. */
export function mergeGrants(grants: PolicyGrant[]): PolicyMap {
  const map: PolicyMap = new Map()
  for (const grant of grants) {
    const existing = map.get(grant.name)
    if (grant.scope === null || existing === null) {
      map.set(grant.name, null)
      continue
    }
    if (existing === undefined) {
      map.set(grant.name, [grant.scope])
    } else if (!existing.includes(grant.scope)) {
      existing.push(grant.scope)
    }
  }
  return map
}
