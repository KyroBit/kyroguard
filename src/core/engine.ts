import { performance } from 'node:perf_hooks'
import { MisconfiguredError, PolicyDeniedError, UnauthenticatedError } from './errors.js'
import { policyCacheKey } from '../cache/key.js'
import { SubjectStore } from './subject-store.js'
import { qualifyPolicyName, toSubjectRef } from './types.js'
import type {
  DecisionEvent,
  DecisionHook,
  FilterResult,
  PolicyMap,
  QualifiedPolicyName,
  Subject,
  SubjectRef,
} from './types.js'
import { blanketScopeName } from './policy.js'
import type { ResourceDefinition } from './policy.js'
import type { CacheHook, InvalidationBus, PolicyCache } from '../cache/types.js'
import { UnknownScopeError } from '../storage/contract.js'
import type { GroupRecord, PolicyGrant, StorageAdapter } from '../storage/contract.js'
import type { Scope } from './scope.js'

export interface EngineOptions {
  adapter: StorageAdapter
  scopes: Map<string, Scope>
  /** null disables caching entirely. */
  cache: PolicyCache | null
  bus: InvalidationBus
  /** The db handle handed to scopes (scoped or raw). */
  db?: unknown
  /** is_super bypasses policy checks. Default true; disable per deployment policy. */
  superBypass?: boolean
  onDecision?: DecisionHook
  onCacheEvent?: CacheHook
}

/** Framework-free engine: authorize() resolves (allow) or throws a typed GuardError (deny). */
export class GuardEngine {
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

  /**
   * The decision procedure: resolves on allow, throws a typed GuardError on
   * deny. It answers whether the subject holds the policy at all. Which rows
   * the grant reaches is the scope's job, and scopes narrow queries rather
   * than refusing requests — see filterFor.
   */
  async authorize(
    subject: Subject | null | undefined,
    policy: QualifiedPolicyName,
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
    this.emitDecision(subject, policy, 'allow', 'granted', scopeNames?.[0] ?? null, cacheHit, startedAt)
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

    // A blanket grant names no scope, so the policy states how far wholesale
    // access reaches. Without that it would read every tenant's rows.
    let cacheHit = false
    let scopeNames: string[] | null
    if (this.superBypass && subject.is_super === true) {
      const blanket = blanketScopeFor(resource, policy, subject.domain)
      if (blanket === null) {
        this.emitDecision(subject, policy, 'allow', 'super', null, false, startedAt, 'list')
        return { kind: 'all' }
      }
      scopeNames = [blanket]
    } else {
      const ref = toSubjectRef(subject)
      const resolved = await this.getPolicyMap(ref)
      cacheHit = resolved.cacheHit

      if (!resolved.map.has(policy)) {
        this.emitDecision(subject, policy, 'deny', 'no-policy', null, cacheHit, startedAt, 'list')
        return { kind: 'none', reason: 'no-policy' }
      }
      scopeNames = resolved.map.get(policy)!
    }
    if (scopeNames === null) {
      this.emitDecision(subject, policy, 'allow', 'granted', null, cacheHit, startedAt, 'list')
      return { kind: 'all' }
    }

    const ctx = { db: this.db, adapter: this.adapter, resource }
    const fragments: unknown[] = []
    const fragmentScopes: string[] = []
    // Scopes run with inAuthz set: a scope querying the db to build its
    // fragment must see the unfiltered table, never its own filter.
    const prevInAuthz = this.store.isInAuthz()
    this.store.setInAuthz(true)
    try {
      for (const scopeName of scopeNames) {
        const scope = this.scopes.get(scopeName)
        if (!scope) {
          this.warnOnce(
            `unknown-scope:${scopeName}`,
            `[kyroguard] Grant references unknown scope "${scopeName}" — it narrows the query to nothing.`,
          )
          continue
        }
        const result = await scope.match(subject, ctx)
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
        `[kyroguard] Adapter "${this.adapter.id}" has no listFilters — cannot OR-combine ${fragments.length} scope fragments; the list is empty.`,
      )
      this.emitDecision(subject, policy, 'deny', 'scope-denied', fragmentScopes.join(','), cacheHit, startedAt, 'list')
      return { kind: 'none', reason: 'unfilterable' }
    }

    this.emitDecision(subject, policy, 'allow', 'granted', fragmentScopes.join(','), cacheHit, startedAt, 'list')
    return { kind: 'where', where: support.or(fragments) }
  }

  /**
   * Guard-path entry: computes the exercised policy's filter and activates it
   * for the current request under the resource type. Storage wrappers key
   * automatic read filtering EXCLUSIVELY on this per-request state — never on
   * static resource config — so the filter always follows the policy the
   * request is exercising.
   */
  /**
   * The columns a row created under this request's grant must carry, merged
   * from every granted scope that defines `insert`. Two scopes disagreeing on
   * one column is a configuration error, not a row to guess at.
   */
  async insertValuesFor(
    subject: Subject | null | undefined,
    policy: QualifiedPolicyName,
    resource: ResourceDefinition,
  ): Promise<Record<string, unknown>> {
    if (!subject?.id) return {}

    // A blanket grant names no scope, so the policy states how far wholesale
    // access reaches — the same scope that narrows its reads must stamp its
    // writes, or a superuser creates rows belonging to no tenant at all.
    let scopeNames: readonly string[] | null | undefined
    if (this.superBypass && subject.is_super === true) {
      const blanket = blanketScopeFor(resource, policy, subject.domain)
      if (blanket === null) return {}
      scopeNames = [blanket]
    } else {
      const { map } = await this.getPolicyMap(toSubjectRef(subject))
      scopeNames = map.get(policy)
    }
    if (!scopeNames) return {}

    const ctx = { db: this.db, adapter: this.adapter, resource }
    const merged: Record<string, unknown> = {}
    const sources = new Map<string, string>()
    const prevInAuthz = this.store.isInAuthz()
    this.store.setInAuthz(true)
    try {
      for (const scopeName of scopeNames) {
        const scope = this.scopes.get(scopeName)
        if (!scope?.insert) continue
        for (const [column, value] of Object.entries(await scope.insert(subject, ctx))) {
          const previous = sources.get(column)
          if (previous !== undefined && merged[column] !== value) {
            throw new MisconfiguredError(
              `[kyroguard] scopes "${previous}" and "${scopeName}" both set "${column}" on create, ` +
                `to different values — a row cannot carry both.`,
            )
          }
          merged[column] = value
          sources.set(column, scopeName)
        }
      }
    } finally {
      this.store.setInAuthz(prevInAuthz)
    }
    return merged
  }

  async storeFilterFor(
    subject: Subject | null | undefined,
    policy: QualifiedPolicyName,
    resource: ResourceDefinition,
  ): Promise<FilterResult> {
    const filter = await this.filterFor(subject, policy, resource)
    this.store.setActiveFilter(resource.type, filter)
    this.store.setActiveInsert(resource.type, await this.insertValuesFor(subject, policy, resource))
    return filter
  }

  // ── Mutations (invalidate + publish, always) ────────────────────────────────

  /** Emits no decision event on purpose: a capability query is not an access attempt. */
  async can(subject: Subject | null | undefined, policy: QualifiedPolicyName): Promise<boolean> {
    if (!subject?.id) return false
    if (this.superBypass && subject.is_super === true) return true
    const { map } = await this.getPolicyMap(toSubjectRef(subject))
    return map.has(policy)
  }

  /** Without `allPolicies` a superuser answers empty, which reads as "may do nothing". */
  async grantsFor(
    subject: Subject | null | undefined,
    allPolicies?: readonly QualifiedPolicyName[],
  ): Promise<PolicyMap> {
    if (!subject?.id) return new Map()
    if (this.superBypass && subject.is_super === true) {
      return new Map((allPolicies ?? []).map(policy => [policy, null]))
    }
    const { map } = await this.getPolicyMap(toSubjectRef(subject))
    // getPolicyMap hands back the cached instance; a caller mutating it would
    // poison every later request for this subject.
    return new Map([...map].map(([policy, scopes]) => [policy, scopes ? [...scopes] : null]))
  }

  async groupsOf(ref: SubjectRef): Promise<GroupRecord[]> {
    return this.adapter.getSubjectGroups(ref)
  }

  async assignGroup(ref: SubjectRef, groupName: string): Promise<void> {
    await this.adapter.assignGroup(ref, groupName)
    await this.invalidateSubject(ref.subjectId)
  }

  async removeGroup(ref: SubjectRef, groupName: string): Promise<void> {
    await this.adapter.removeGroup(ref, groupName)
    await this.invalidateSubject(ref.subjectId)
  }

  async assignPolicy(ref: SubjectRef, policyName: QualifiedPolicyName, scope?: string): Promise<void> {
    const stored = scope === 'all' || scope === undefined ? null : scope
    if (typeof stored === 'string') {
      const record = (await this.adapter.listPolicies()).find(policy => policy.name === policyName)
      if (record && !record.scopeOptions.includes(stored)) {
        throw new UnknownScopeError(policyName, stored)
      }
    }
    await this.adapter.assignPolicy(ref, policyName, stored)
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
/** The blanket scope for the policy this request exercises, if the policy states one. */
function blanketScopeFor(
  resource: ResourceDefinition,
  qualified: QualifiedPolicyName,
  domain: string | undefined,
): string | null {
  const prefix = domain ? `${domain}.` : ''
  const unqualified = prefix && qualified.startsWith(prefix) ? qualified.slice(prefix.length) : qualified
  const policy = resource.policies.find(entry => entry.name === unqualified)
  return policy ? blanketScopeName(policy) : null
}

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
