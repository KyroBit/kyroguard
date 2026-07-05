import { describe, test, expect } from 'bun:test'
import { RbacEngine } from '../../src/core/engine.js'
import { PolicyDeniedError } from '../../src/core/errors.js'
import { inProcessBus } from '../../src/cache/bus.js'
import { memoryCache } from '../../src/cache/memory.js'
import { memoryAdapter } from '../../src/testing/index.js'
import type { EngineOptions } from '../../src/core/engine.js'
import type { SubjectRef } from '../../src/core/types.js'
import type { InvalidationBus, InvalidationEvent } from '../../src/cache/types.js'
import type { StorageAdapter } from '../../src/storage/contract.js'

/** Wrap an adapter counting getSubjectPolicies calls (the enforcement hot path). */
function countingAdapter(): { adapter: StorageAdapter; calls: () => number } {
  const inner = memoryAdapter()
  let count = 0
  const adapter: StorageAdapter = {
    ...inner,
    getSubjectPolicies(ref) {
      count += 1
      return inner.getSubjectPolicies(ref)
    },
  }
  return { adapter, calls: () => count }
}

interface Harness {
  adapter: StorageAdapter
  calls: () => number
  bus: InvalidationBus
  engine: RbacEngine
}

function makeEngine(overrides?: Partial<EngineOptions>): Harness {
  const { adapter, calls } = countingAdapter()
  const bus = inProcessBus()
  const engine = new RbacEngine({
    adapter,
    scopes: new Map(),
    cache: memoryCache({ maxEntries: 100, ttlMs: 60_000 }),
    bus,
    ...overrides,
  })
  return { adapter, calls, bus, engine }
}

async function grant(adapter: StorageAdapter, ref: SubjectRef, policy: string): Promise<void> {
  await adapter.upsertPolicies([
    { name: policy, domain: ref.domain, label: policy, scopeOptions: [], dependsOn: [] },
  ])
  await adapter.assignPolicy(ref, policy, null)
}

describe('policy cache behavior', () => {
  test('second authorize is served from cache — adapter hit exactly once', async () => {
    const { adapter, calls, engine } = makeEngine()
    await grant(adapter, { subjectId: 'u1', domain: 'admin', tenantId: '' }, 'admin.posts.read')

    await engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.posts.read')
    expect(calls()).toBe(1)
    await engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.posts.read')
    expect(calls()).toBe(1)
  })

  test("cache keys isolate domain/tenant: ('u1','', 'admin') never shares an entry with ('u1','admin','') — v0 collision regression", async () => {
    const { adapter, engine } = makeEngine()
    // Grant only to the (domain '', tenant 'admin') tuple.
    await grant(adapter, { subjectId: 'u1', domain: '', tenantId: 'admin' }, 'posts.read')

    // Populate the cache for the granted tuple.
    await engine.authorize({ id: 'u1', tenant_id: 'admin' }, 'posts.read')

    // The transposed tuple must NOT read that cached policy map.
    expect(engine.authorize({ id: 'u1', domain: 'admin' }, 'posts.read')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    )
  })

  test("subject id containing ':' cannot collide with another tuple", async () => {
    const { adapter, engine } = makeEngine()
    // Grant to subject 'u1' on domain 'admin'.
    await grant(adapter, { subjectId: 'u1', domain: 'admin', tenantId: '' }, 'admin.posts.read')
    await engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.posts.read')

    // Subject literally named 'u1:admin' with no domain must not hit that entry.
    expect(engine.authorize({ id: 'u1:admin' }, 'admin.posts.read')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    )
  })

  test('engine.assignGroup invalidates the cached (stale-deny) entry AND publishes on the bus', async () => {
    const { adapter, engine, bus } = makeEngine()
    const published: InvalidationEvent[] = []
    bus.subscribe(event => published.push(event))

    const ref: SubjectRef = { subjectId: 'u1', domain: 'admin', tenantId: '' }
    await adapter.upsertPolicies([
      { name: 'admin.posts.read', domain: 'admin', label: 'read', scopeOptions: [], dependsOn: [] },
    ])
    await adapter.upsertGroup({ name: 'editors', label: 'Editors' })
    await adapter.setGroupPolicies('editors', [{ policyName: 'admin.posts.read', scope: null }])

    // Cache a deny (empty map) for u1.
    expect(engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.posts.read')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    )

    await engine.assignGroup(ref, 'editors')
    expect(published).toContainEqual({ type: 'subject', subjectId: 'u1' })

    // Without invalidation this would still be the stale cached deny.
    await engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.posts.read')
  })

  test('engine.removePolicy invalidates the cached allow AND publishes on the bus', async () => {
    const { adapter, engine, bus } = makeEngine()
    const published: InvalidationEvent[] = []
    bus.subscribe(event => published.push(event))

    const ref: SubjectRef = { subjectId: 'u1', domain: 'admin', tenantId: '' }
    await grant(adapter, ref, 'admin.posts.read')
    await engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.posts.read') // cached allow

    await engine.removePolicy(ref, 'admin.posts.read')
    expect(published).toContainEqual({ type: 'subject', subjectId: 'u1' })

    // A stale cache would still allow here.
    expect(engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.posts.read')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    )
  })

  test("a bus event published by 'another instance' invalidates the local cache", async () => {
    const { adapter, calls, engine, bus } = makeEngine()
    const ref: SubjectRef = { subjectId: 'u1', domain: 'admin', tenantId: '' }
    await grant(adapter, ref, 'admin.posts.read')

    await engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.posts.read')
    expect(calls()).toBe(1)

    // Simulate a mutation done by another process: adapter-level change + bus event.
    await adapter.removePolicy(ref, 'admin.posts.read')
    await bus.publish({ type: 'subject', subjectId: 'u1' })

    // The cached allow must be gone: the adapter is consulted again and denies.
    expect(engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.posts.read')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    )
    expect(calls()).toBe(2)
  })

  test("a bus 'all' event clears the cache", async () => {
    const { adapter, calls, engine, bus } = makeEngine()
    await grant(adapter, { subjectId: 'u1', domain: 'admin', tenantId: '' }, 'admin.posts.read')

    await engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.posts.read')
    await bus.publish({ type: 'all' })
    await engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.posts.read')
    expect(calls()).toBe(2)
  })
})

describe('onDecision hook', () => {
  test('fires with correct reason and cacheHit fields across the decision matrix', async () => {
    const events: Parameters<NonNullable<EngineOptions['onDecision']>>[0][] = []
    const { adapter, engine } = makeEngine({ onDecision: event => events.push(event) })
    await grant(adapter, { subjectId: 'u1', domain: 'admin', tenantId: '' }, 'admin.posts.read')

    await engine.authorize(null, 'admin.posts.read').catch(() => {})
    await engine.authorize({ id: 'root', is_super: true }, 'admin.posts.read')
    await engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.posts.read') // miss → allow
    await engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.posts.read') // hit → allow
    await engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.other.policy').catch(() => {}) // hit → deny

    expect(events).toHaveLength(5)

    expect(events[0]).toMatchObject({ decision: 'deny', reason: 'no-subject', cacheHit: false })
    expect(events[1]).toMatchObject({
      decision: 'allow',
      reason: 'super',
      subjectId: 'root',
      cacheHit: false,
    })
    expect(events[2]).toMatchObject({
      decision: 'allow',
      reason: 'granted',
      subjectId: 'u1',
      domain: 'admin',
      policy: 'admin.posts.read',
      scope: null,
      cacheHit: false,
    })
    expect(events[3]).toMatchObject({ decision: 'allow', reason: 'granted', cacheHit: true })
    expect(events[4]).toMatchObject({
      decision: 'deny',
      reason: 'no-policy',
      policy: 'admin.other.policy',
      cacheHit: true,
    })
    for (const event of events) expect(typeof event.durationMs).toBe('number')
  })

  test('a throwing onDecision hook never breaks authorization (allow and deny paths)', async () => {
    const { adapter, engine } = makeEngine({
      onDecision: () => {
        throw new Error('observability exploded')
      },
    })
    await grant(adapter, { subjectId: 'u1', domain: 'admin', tenantId: '' }, 'admin.posts.read')

    // Allow still resolves.
    await engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.posts.read')
    // Deny still throws the RBAC error, not the hook's error.
    expect(engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.nope')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    )
  })
})

describe('onCacheEvent hook', () => {
  test('miss → set → hit → invalidate-subject sequence', async () => {
    const events: { type: string; subjectId?: string }[] = []
    const { adapter, engine } = makeEngine({ onCacheEvent: event => events.push(event) })
    const ref: SubjectRef = { subjectId: 'u1', domain: 'admin', tenantId: '' }
    await grant(adapter, ref, 'admin.posts.read')

    await engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.posts.read')
    await engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.posts.read')
    await engine.invalidateSubject('u1')

    expect(events).toEqual([
      { type: 'miss', subjectId: 'u1' },
      { type: 'set', subjectId: 'u1' },
      { type: 'hit', subjectId: 'u1' },
      { type: 'invalidate-subject', subjectId: 'u1' },
    ])
  })

  test('clearCache emits clear; a throwing hook never breaks the operation', async () => {
    const events: { type: string }[] = []
    const { engine } = makeEngine({
      onCacheEvent: event => {
        events.push(event)
        throw new Error('metrics exploded')
      },
    })
    await engine.clearCache()
    expect(events).toEqual([{ type: 'clear' }])
  })
})
