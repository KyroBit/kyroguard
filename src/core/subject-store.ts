import { AsyncLocalStorage } from 'node:async_hooks'
import type { Subject } from './types.js'

/**
 * Per-request state. Created once per request by the framework integration's
 * context hook/middleware; read by guards and by ownership tracking.
 */
export interface RequestStore {
  /** The active subject (set by a guard after resolution, or by setSubject). */
  subject: Subject | null
  /** Per-portal memoized resolutions — two portals on one app never collide. */
  portalSubjects: Map<string, Subject | null>
  /** One-shot extra columns for the next tracked insert (addExtra). */
  extraOnce: Record<string, unknown> | null
}

/**
 * Instance-scoped ALS wrapper. Each RbacEngine owns its own storage —
 * module-level state is gone, so two engines in one process are isolated
 * and tests never leak context between apps.
 *
 * Bun note: callers must use the callback form (`run(store, done)`) inside
 * framework hooks — awaiting a promise that resolves inside `run()` does not
 * propagate context under Bun (verified regression, kept in the test suite).
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

  consumeExtra(): Record<string, unknown> | null {
    const store = this.als.getStore()
    if (!store?.extraOnce) return null
    const extra = store.extraOnce
    store.extraOnce = null
    return extra
  }
}

function createStore(): RequestStore {
  return { subject: null, portalSubjects: new Map(), extraOnce: null }
}
