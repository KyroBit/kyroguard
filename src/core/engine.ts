import { performance } from 'node:perf_hooks'
import {
  PolicyDeniedError,
  ResourceNotFoundError,
  ScopeDeniedError,
  UnauthenticatedError,
} from './errors.js'
import { policyCacheKey } from '../cache/key.js'
import { SubjectStore } from './subject-store.js'
import { qualifyPolicyName, toSubjectRef } from './types.js'
import type {
  Awaitable,
  DecisionEvent,
  DecisionHook,
  PolicyMap,
  QualifiedPolicyName,
  ResourceRef,
  Subject,
  SubjectRef,
} from './types.js'
import type { CacheHook, InvalidationBus, PolicyCache } from '../cache/types.js'
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

/**
 * Framework-free authorization engine. Guards call authorize(); it either
 * resolves (allow) or throws a typed RbacError (deny). No HTTP anywhere.
 */
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

    // Every bus delivery invalidates locally. Events are idempotent, so
    // receiving our own publication is harmless.
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

  /**
   * Resolve the subject's policy map, via cache when enabled.
   * The merge rule (S4 is adapter-side no-dedup; precedence is ours):
   * for duplicate grants of one policy, a null scope (unrestricted) wins
   * over any named scope; two different named scopes keep the first —
   * deterministic because adapters return rows in stable order.
   */
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

  /**
   * The decision procedure. Throws:
   *   UnauthenticatedError  — no subject / empty subject id      (401)
   *   PolicyDeniedError     — policy not granted here            (403)
   *   ScopeDeniedError      — scoped grant, check rejected       (403)
   *   ResourceNotFoundError — scoped grant, resource unresolved  (404)
   */
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

    const scopeName = map.get(policy)!
    if (scopeName === null) {
      this.emitDecision(subject, policy, 'allow', 'granted', null, cacheHit, startedAt)
      return
    }

    // Scoped grant: an unknown scope name is a deny, never a bypass.
    const scope = this.scopes.get(scopeName)
    if (!scope) {
      this.emitDecision(subject, policy, 'deny', 'scope-denied', scopeName, cacheHit, startedAt)
      throw new ScopeDeniedError(policy, scopeName)
    }

    // A resolver is only required by scopes that inspect the row. Without
    // one, the scope decides on null (row-based scopes like Scope.owned()
    // fail closed; condition scopes like business hours pass regardless).
    // A resolver that finds nothing is still a 404 — the route pointed at
    // a row that does not exist.
    let resource: ResourceRef | null = null
    if (options?.resource) {
      resource = (await options.resource()) ?? null
      if (!resource) {
        this.emitDecision(subject, policy, 'deny', 'resource-not-found', scopeName, cacheHit, startedAt)
        throw new ResourceNotFoundError()
      }
    }

    const allowed = await scope.check(subject, resource, { db: this.db, adapter: this.adapter })
    if (!allowed) {
      this.emitDecision(subject, policy, 'deny', 'scope-denied', scopeName, cacheHit, startedAt)
      throw new ScopeDeniedError(policy, scopeName)
    }

    this.emitDecision(subject, policy, 'allow', 'granted', scopeName, cacheHit, startedAt)
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

  private emitDecision(
    subject: Subject | null | undefined,
    policy: QualifiedPolicyName,
    decision: DecisionEvent['decision'],
    reason: DecisionEvent['reason'],
    scope: string | null,
    cacheHit: boolean,
    startedAt: number,
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

/** Null scope (unrestricted) wins over any named scope; first named scope otherwise. */
export function mergeGrants(grants: PolicyGrant[]): PolicyMap {
  const map: PolicyMap = new Map()
  for (const grant of grants) {
    const existing = map.get(grant.name)
    if (existing === undefined) {
      map.set(grant.name, grant.scope)
    } else if (existing !== null && grant.scope === null) {
      map.set(grant.name, null)
    }
  }
  return map
}
