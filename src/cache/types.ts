/**
 * Policy cache abstraction.
 *
 * The cache is created inside createRbac() — instance-scoped, never
 * module-level, so two apps in one process cannot share (or poison) each
 * other's entries and tests reset it for free.
 */

import type { Awaitable, PolicyMap } from '../core/types.js'

/**
 * Collision-proof cache key. Fixed arity and per-component encoding: a ':'
 * inside a subject id, domain or tenant id is escaped, and empty components
 * stay in position — ('u1', '', 't1') and ('u1', 't1', '') produce
 * different ids. The `rbac:v1:<subject>:` prefix makes per-subject
 * invalidation a prefix operation in external stores.
 */
export interface PolicyCacheKey {
  /** Full encoded key: `rbac:v1:<enc(subjectId)>:<enc(domain)>:<enc(tenantId)>` */
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

/**
 * Cross-instance invalidation (the casbin "watcher" analog). The engine
 * publishes after every assignment mutation it performs and invalidates its
 * local cache on every delivery. Events are idempotent, so receiving your
 * own publication is harmless. The default bus is in-process; `redisBus()`
 * adapts any ioredis-compatible client pair.
 */
export type InvalidationEvent = { type: 'subject'; subjectId: string } | { type: 'all' }

export interface InvalidationBus {
  publish(event: InvalidationEvent): Awaitable<void>
  /** Returns an unsubscribe function. */
  subscribe(handler: (event: InvalidationEvent) => void): () => void
  /**
   * Release underlying transport resources (e.g. the Redis channel
   * subscription). The bus owner calls this at shutdown — engine.dispose()
   * only detaches its own handler.
   */
  close?(): Awaitable<void>
}

export interface CacheEvent {
  type: 'hit' | 'miss' | 'set' | 'invalidate-subject' | 'clear'
  subjectId?: string
}

export type CacheHook = (event: CacheEvent) => void
