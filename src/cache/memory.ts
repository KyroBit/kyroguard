import type { PolicyMap } from '../core/types.js'
import type { PolicyCache, PolicyCacheKey } from './types.js'

export interface MemoryCacheOptions {
  maxEntries: number
  ttlMs: number
}

interface Entry {
  value: PolicyMap
  expiresAt: number
  subjectId: string
}

/** Bounded in-memory LRU with per-entry TTL; recency is Map insertion order. */
export function memoryCache(options: MemoryCacheOptions): PolicyCache {
  const { maxEntries, ttlMs } = options
  const entries = new Map<string, Entry>()

  return {
    get(key: PolicyCacheKey): PolicyMap | undefined {
      const entry = entries.get(key.id)
      if (!entry) return undefined
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key.id)
        return undefined
      }
      entries.delete(key.id)
      entries.set(key.id, entry)
      return entry.value
    },

    set(key: PolicyCacheKey, value: PolicyMap): void {
      entries.delete(key.id)
      entries.set(key.id, {
        value,
        expiresAt: Date.now() + ttlMs,
        subjectId: key.subjectId,
      })
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next()
        if (oldest.done) break
        entries.delete(oldest.value)
      }
    },

    // Exact compare on the stored raw subjectId — never prefix-match the
    // encoded key id, which could cross subject boundaries.
    invalidateSubject(subjectId: string): void {
      for (const [id, entry] of entries) {
        if (entry.subjectId === subjectId) entries.delete(id)
      }
    },

    clear(): void {
      entries.clear()
    },
  }
}
