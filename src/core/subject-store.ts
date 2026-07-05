import { AsyncLocalStorage } from 'node:async_hooks'
import type { FilterResult, Subject } from './types.js'

/** Per-request state, created by the framework integration's context hook. */
export interface RequestStore {
  /** The active subject (set by a guard after resolution, or by setSubject). */
  subject: Subject | null
  /** Per-domain memoized resolutions — two domains on one app never collide. */
  domainSubjects: Map<string, Subject | null>
  /** One-shot extra columns for the next tracked insert (addExtra). */
  extraOnce: Record<string, unknown> | null
  /** True while the engine evaluates scopes/filters — wrappers must not auto-filter these queries. */
  inAuthz: boolean
  /**
   * Read filters activated by guards for THIS request, resource type →
   * the exercised policy's FilterResult. Absence means "no auto filter":
   * wrappers must never fall back to any statically-configured plan.
   */
  activeFilters: Map<string, FilterResult>
}

/**
 * Instance-scoped ALS wrapper; each RbacEngine owns its own storage.
 *
 * Bun note: callers must use the callback form (`run(store, done)`) inside
 * framework hooks — awaiting a promise that resolves inside `run()` does not
 * propagate context under Bun (verified regression, kept in the test suite).
 * Same family: a `run()` callback containing awaits must `return await x`,
 * never `return x`, when x is a lazy thenable (Prisma/mongoose query) — the
 * bare return subscribes to it outside the ALS frame.
 */
export class SubjectStore {
  private readonly als = new AsyncLocalStorage<RequestStore>()

  run<T>(fn: () => T): T {
    return this.als.run(createStore(), fn)
  }

  /** Callback-style entry for Fastify/Express hooks (see Bun note above). */
  enter(done: () => void): void {
    this.als.run(createStore(), done)
  }

  get(): RequestStore | undefined {
    return this.als.getStore()
  }

  setSubject(subject: Subject): void {
    const store = this.als.getStore()
    if (store) store.subject = subject
  }

  getSubject(): Subject | null {
    return this.als.getStore()?.subject ?? null
  }

  addExtra(extra: Record<string, unknown>): void {
    const store = this.als.getStore()
    if (!store) return
    store.extraOnce = { ...(store.extraOnce ?? {}), ...extra }
  }

  setActiveFilter(resourceType: string, filter: FilterResult): void {
    this.als.getStore()?.activeFilters.set(resourceType, filter)
  }

  getActiveFilter(resourceType: string): FilterResult | undefined {
    return this.als.getStore()?.activeFilters.get(resourceType)
  }

  setInAuthz(value: boolean): void {
    const store = this.als.getStore()
    if (store) store.inAuthz = value
  }

  isInAuthz(): boolean {
    return this.als.getStore()?.inAuthz ?? false
  }

  consumeExtra(): Record<string, unknown> | null {
    const store = this.als.getStore()
    if (!store?.extraOnce) return null
    const extra = store.extraOnce
    store.extraOnce = null
    return extra
  }
}

function createStore(): RequestStore {
  return {
    subject: null,
    domainSubjects: new Map(),
    extraOnce: null,
    inAuthz: false,
    activeFilters: new Map(),
  }
}
