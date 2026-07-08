import type { Awaitable, PolicyMap } from '../core/types.js'

/**
 * Collision-proof cache key. Fixed arity and per-component encoding: a ':'
 * inside a subject id, domain or tenant id is escaped, and empty components
 * stay in position — ('u1', '', 't1') and ('u1', 't1', '') produce
 * different ids. The `kyroguard:v1:<subject>:` prefix makes per-subject
 * invalidation a prefix operation in external stores.
 */
export interface PolicyCacheKey {
  /** Full encoded key: `kyroguard:v1:<enc(subjectId)>:<enc(domain)>:<enc(tenantId)>` */
  id: string
  subjectId: string
  domain: string
  tenantId: string
}

export interface PolicyCache {
  get(key: PolicyCacheKey): Awaitable<PolicyMap | undefined>
  set(key: PolicyCacheKey, value: PolicyMap): Awaitable<void>
  invalidateSubject(subjectId: string): Awaitable<void>
  clear(): Awaitable<void>
}

/** Cross-instance invalidation events; idempotent — receiving your own publication is harmless. */
export type InvalidationEvent = { type: 'subject'; subjectId: string } | { type: 'all' }

export interface InvalidationBus {
  publish(event: InvalidationEvent): Awaitable<void>
  /** Returns an unsubscribe function. */
  subscribe(handler: (event: InvalidationEvent) => void): () => void
  /** Releases transport resources; the bus owner calls this — engine.dispose() only detaches its handler. */
  close?(): Awaitable<void>
}

export interface CacheEvent {
  type: 'hit' | 'miss' | 'set' | 'invalidate-subject' | 'clear'
  subjectId?: string
}

export type CacheHook = (event: CacheEvent) => void
