import { AsyncLocalStorage } from 'node:async_hooks'
import type { Subject } from './policy.js'

export interface RbacStore {
  subject:      Subject
  context:      string
  extraOnce:    Record<string, unknown> | null  // per-insert override via rbac.addExtra()
}

export const storage = new AsyncLocalStorage<RbacStore>()

export function getStore(): RbacStore | undefined {
  return storage.getStore()
}

export function setContext(subject: Subject, context: string): void {
  const existing = storage.getStore()
  if (existing) {
    existing.subject = subject
    existing.context = context
  }
  // store is initialised in the plugin's onRequest hook
}

export function addExtra(extra: Record<string, unknown>): void {
  const store = storage.getStore()
  if (!store) return
  store.extraOnce = { ...(store.extraOnce ?? {}), ...extra }
}

export function consumeExtra(): Record<string, unknown> | null {
  const store = storage.getStore()
  if (!store?.extraOnce) return null
  const extra  = store.extraOnce
  store.extraOnce = null   // consume once — cleared after the insert
  return extra
}
