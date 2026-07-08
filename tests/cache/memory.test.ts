/// <reference types="bun-types" />
import { describe, test, expect } from 'bun:test'
import { memoryCache } from '../../src/cache/memory.js'
import { policyCacheKey } from '../../src/cache/key.js'
import type { PolicyMap } from '../../src/core/types.js'

const key = (subjectId: string, domain = 'p', tenantId = 'c') =>
  policyCacheKey(subjectId, domain, tenantId)

const policy = (name: string): PolicyMap => new Map([[name, null]])

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('memoryCache', () => {
  test('get/set round-trip returns the stored PolicyMap', async () => {
    const cache = memoryCache({ maxEntries: 10, ttlMs: 60_000 })
    const k = key('u1')
    const value = policy('perm.read')
    await cache.set(k, value)
    expect(await cache.get(k)).toBe(value)
  })

  test('miss returns undefined', async () => {
    const cache = memoryCache({ maxEntries: 10, ttlMs: 60_000 })
    expect(await cache.get(key('nobody'))).toBeUndefined()
  })

  test('LRU: get() refreshes recency so the touched entry survives eviction', async () => {
    const cache = memoryCache({ maxEntries: 3, ttlMs: 60_000 })
    const kA = key('a')
    const kB = key('b')
    const kC = key('c')
    await cache.set(kA, policy('a'))
    await cache.set(kB, policy('b'))
    await cache.set(kC, policy('c'))
    // Touch the oldest (a); now b is least recently used.
    expect(await cache.get(kA)).toBeDefined()
    await cache.set(key('d'), policy('d'))
    expect(await cache.get(kA)).toBeDefined() // touched entry survived
    expect(await cache.get(kB)).toBeUndefined() // untouched oldest evicted
    expect(await cache.get(kC)).toBeDefined()
    expect(await cache.get(key('d'))).toBeDefined()
  })

  test('TTL: entry expires after ttlMs', async () => {
    const cache = memoryCache({ maxEntries: 10, ttlMs: 50 })
    const k = key('u1')
    await cache.set(k, policy('perm'))
    expect(await cache.get(k)).toBeDefined()
    await sleep(80)
    expect(await cache.get(k)).toBeUndefined()
  })

  test('maxEntries 0 stores nothing', async () => {
    const cache = memoryCache({ maxEntries: 0, ttlMs: 60_000 })
    const k = key('u1')
    await cache.set(k, policy('perm'))
    expect(await cache.get(k)).toBeUndefined()
  })

  test("invalidateSubject removes exactly that subject's entries (raw-id exact match)", async () => {
    const cache = memoryCache({ maxEntries: 10, ttlMs: 60_000 })
    const u1a = key('u1', 'p1', 'c1')
    const u1b = key('u1', 'p2', 'c2')
    const u1x = key('u1x')
    const u = key('u')
    await cache.set(u1a, policy('1a'))
    await cache.set(u1b, policy('1b'))
    await cache.set(u1x, policy('1x'))
    await cache.set(u, policy('u'))

    await cache.invalidateSubject('u1')

    expect(await cache.get(u1a)).toBeUndefined()
    expect(await cache.get(u1b)).toBeUndefined()
    // 'u1' must not clear 'u1x' or 'u' — the startsWith over-clear regression.
    expect(await cache.get(u1x)).toBeDefined()
    expect(await cache.get(u)).toBeDefined()
  })

  test('invalidateSubject with a subject that has no entries is a no-op', async () => {
    const cache = memoryCache({ maxEntries: 10, ttlMs: 60_000 })
    const k = key('u1')
    await cache.set(k, policy('perm'))
    await cache.invalidateSubject('someone-else')
    expect(await cache.get(k)).toBeDefined()
  })

  test('clear() empties the cache', async () => {
    const cache = memoryCache({ maxEntries: 10, ttlMs: 60_000 })
    const kA = key('a')
    const kB = key('b')
    await cache.set(kA, policy('a'))
    await cache.set(kB, policy('b'))
    await cache.clear()
    expect(await cache.get(kA)).toBeUndefined()
    expect(await cache.get(kB)).toBeUndefined()
  })

  test('set() overwrites an existing key without growing the cache', async () => {
    const cache = memoryCache({ maxEntries: 2, ttlMs: 60_000 })
    const k = key('u1')
    await cache.set(k, policy('old'))
    await cache.set(k, policy('new'))
    await cache.set(key('u2'), policy('u2'))
    // Both fit: the overwrite did not consume a second slot.
    expect((await cache.get(k))?.has('new')).toBe(true)
    expect(await cache.get(key('u2'))).toBeDefined()
  })
})