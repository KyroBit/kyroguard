/**
 * Policy cache
 *
 * The cache is keyed by subjectId + portal + contextId. Each combination is
 * independent. clearPolicyCache() by subject must not evict other subjects,
 * and a full clear must reset everything.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { createMockAdapter, buildApp, req } from './helpers.js'
import { clearPolicyCache } from '../src/require-policy.js'

describe('Policy cache', () => {
  const mock = createMockAdapter()
  beforeEach(() => mock.reset())

  test('second request uses cached policy map (adapter called only once)', async () => {
    let callCount = 0
    const adapter = mock.adapter
    const originalFn = adapter.getSubjectGroupPolicies.bind(adapter)
    adapter.getSubjectGroupPolicies = async (...args) => {
      callCount++
      return originalFn(...args)
    }

    mock.seed({
      subjectId: 'alice',
      portal:    'admin',
      contextId: null,
      policies:  [{ name: 'admin.post.view', scope: null }],
    })

    const app = await buildApp(mock, 'admin', [{ path: '/posts', policy: 'post.view' }])

    await req(app, { url: '/posts', userId: 'alice' })
    await req(app, { url: '/posts', userId: 'alice' })

    expect(callCount).toBe(1) // second request served from cache
  })

  test('clearPolicyCache(subjectId) only evicts that subject', async () => {
    mock.seed({
      subjectId: 'alice',
      portal:    'admin',
      contextId: null,
      policies:  [{ name: 'admin.post.view', scope: null }],
    })
    mock.seed({
      subjectId: 'bob',
      portal:    'admin',
      contextId: null,
      policies:  [{ name: 'admin.post.view', scope: null }],
    })

    const app = await buildApp(mock, 'admin', [{ path: '/posts', policy: 'post.view' }])

    // Warm up caches for both users
    await req(app, { url: '/posts', userId: 'alice' })
    await req(app, { url: '/posts', userId: 'bob' })

    let callCount = 0
    const original = mock.adapter.getSubjectGroupPolicies.bind(mock.adapter)
    mock.adapter.getSubjectGroupPolicies = async (...args) => {
      callCount++
      return original(...args)
    }

    // Clear only alice's cache
    clearPolicyCache('alice')

    await req(app, { url: '/posts', userId: 'alice' })
    await req(app, { url: '/posts', userId: 'bob' })

    expect(callCount).toBe(1) // only alice's was evicted; bob served from cache
  })

  test('clearPolicyCache() (no arg) clears all entries', async () => {
    mock.seed({
      subjectId: 'alice',
      portal:    'admin',
      contextId: null,
      policies:  [{ name: 'admin.post.view', scope: null }],
    })

    const app = await buildApp(mock, 'admin', [{ path: '/posts', policy: 'post.view' }])
    await req(app, { url: '/posts', userId: 'alice' })

    clearPolicyCache()

    let callCount = 0
    const original = mock.adapter.getSubjectGroupPolicies.bind(mock.adapter)
    mock.adapter.getSubjectGroupPolicies = async (...args) => {
      callCount++
      return original(...args)
    }

    await req(app, { url: '/posts', userId: 'alice' })
    expect(callCount).toBe(1) // re-fetched after global clear
  })

  test('portal+context combination has its own cache entry', async () => {
    const callArgs: [string, string | null | undefined, string | null | undefined][] = []
    const original = mock.adapter.getSubjectGroupPolicies.bind(mock.adapter)
    mock.adapter.getSubjectGroupPolicies = async (subjectId, portal, contextId) => {
      callArgs.push([subjectId, portal ?? null, contextId ?? null])
      return original(subjectId, portal, contextId)
    }

    mock.seed({
      subjectId: 'alice',
      portal:    'branch',
      contextId: 'branch-1',
      policies:  [{ name: 'branch.post.view', scope: null }],
    })
    mock.seed({
      subjectId: 'alice',
      portal:    'branch',
      contextId: 'branch-2',
      policies:  [{ name: 'branch.post.view', scope: null }],
    })

    const b1 = await buildApp(mock, 'branch', [{ path: '/posts', policy: 'post.view' }])
    const b2 = await buildApp(mock, 'branch', [{ path: '/posts', policy: 'post.view' }])

    await req(b1, { url: '/posts', userId: 'alice', contextId: 'branch-1' })
    await req(b2, { url: '/posts', userId: 'alice', contextId: 'branch-2' })

    // Both cache misses — different contextIds produce different keys
    expect(callArgs.length).toBe(2)
    expect(callArgs[0]).toEqual(['alice', 'branch', 'branch-1'])
    expect(callArgs[1]).toEqual(['alice', 'branch', 'branch-2'])

    // Second requests hit cache
    await req(b1, { url: '/posts', userId: 'alice', contextId: 'branch-1' })
    await req(b2, { url: '/posts', userId: 'alice', contextId: 'branch-2' })
    expect(callArgs.length).toBe(2) // no additional calls
  })
})
