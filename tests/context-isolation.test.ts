/**
 * CRITICAL — Context / tenant isolation
 *
 * A user's assignment in context "branch-1" must NEVER grant access in
 * context "branch-2". There is NO global fallback — strict exact match only.
 *
 * This covers the most dangerous data-leak scenario: one tenant reading
 * or mutating another tenant's records.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { createMockAdapter, buildApp, req } from './helpers.js'

describe('Context isolation', () => {
  const mock = createMockAdapter()
  beforeEach(() => mock.reset())

  // ── Cross-context bleed ────────────────────────────────────────────────────

  test('branch-1 assignment does not grant access in branch-2', async () => {
    mock.seed({
      subjectId: 'david',
      portal:    'branch',
      contextId: 'branch-1',
      policies:  [{ name: 'branch.transaction.view', scope: null }],
    })

    const app = await buildApp(mock, 'branch', [
      { path: '/transactions', policy: 'transaction.view' },
    ])

    const res = await req(app, { url: '/transactions', userId: 'david', contextId: 'branch-2' })
    expect(res.statusCode).toBe(403)
  })

  test('branch-2 assignment does not grant access in branch-1', async () => {
    mock.seed({
      subjectId: 'david',
      portal:    'branch',
      contextId: 'branch-2',
      policies:  [{ name: 'branch.transaction.create', scope: null }],
    })

    const app = await buildApp(mock, 'branch', [
      { path: '/transactions', policy: 'transaction.create' },
    ])

    const res = await req(app, { url: '/transactions', userId: 'david', contextId: 'branch-1' })
    expect(res.statusCode).toBe(403)
  })

  // ── No global fallback (the old "IS NULL OR =" bug) ────────────────────────

  test('null-context assignment does NOT apply to a request with an explicit context', async () => {
    // This is the critical regression test for the "global assignment" bug.
    // Before the fix, null-context assignments would match any context.
    mock.seed({
      subjectId: 'david',
      portal:    'branch',
      contextId: null,   // was previously treated as "global" — must NOT match
      policies:  [{ name: 'branch.transaction.view', scope: null }],
    })

    const app = await buildApp(mock, 'branch', [
      { path: '/transactions', policy: 'transaction.view' },
    ])

    const res = await req(app, { url: '/transactions', userId: 'david', contextId: 'branch-1' })
    expect(res.statusCode).toBe(403)
  })

  test('explicit-context assignment does NOT apply to a request with no context', async () => {
    mock.seed({
      subjectId: 'david',
      portal:    'branch',
      contextId: 'branch-1',
      policies:  [{ name: 'branch.transaction.view', scope: null }],
    })

    const app = await buildApp(mock, 'branch', [
      { path: '/transactions', policy: 'transaction.view' },
    ])

    // No x-context-id header → context_id is undefined (null)
    const res = await req(app, { url: '/transactions', userId: 'david' })
    expect(res.statusCode).toBe(403)
  })

  // ── Multi-context user — only the matching context is active ───────────────

  test('user with roles in two branches only gets the matching branch role', async () => {
    // David is manager in branch-1 and teller in branch-2
    mock.seed({
      subjectId: 'david',
      portal:    'branch',
      contextId: 'branch-1',
      policies:  [
        { name: 'branch.transaction.view', scope: null },
        { name: 'branch.transaction.void', scope: null },
      ],
    })
    mock.seed({
      subjectId: 'david',
      portal:    'branch',
      contextId: 'branch-2',
      policies:  [
        { name: 'branch.transaction.view', scope: null },
        // no void
      ],
    })

    const app = await buildApp(mock, 'branch', [
      { path: '/view', policy: 'transaction.view' },
      { path: '/void', policy: 'transaction.void' },
    ])

    // In branch-1: both allowed
    expect((await req(app, { url: '/view', userId: 'david', contextId: 'branch-1' })).statusCode).toBe(200)
    expect((await req(app, { url: '/void', userId: 'david', contextId: 'branch-1' })).statusCode).toBe(200)

    // In branch-2: view allowed, void forbidden
    expect((await req(app, { url: '/view', userId: 'david', contextId: 'branch-2' })).statusCode).toBe(200)
    expect((await req(app, { url: '/void', userId: 'david', contextId: 'branch-2' })).statusCode).toBe(403)

    // In branch-3 (unassigned): all forbidden
    expect((await req(app, { url: '/view', userId: 'david', contextId: 'branch-3' })).statusCode).toBe(403)
  })

  // ── Happy-path control ─────────────────────────────────────────────────────

  test('exact context match grants access', async () => {
    mock.seed({
      subjectId: 'alice',
      portal:    'branch',
      contextId: 'branch-1',
      policies:  [{ name: 'branch.transaction.view', scope: null }],
    })

    const app = await buildApp(mock, 'branch', [
      { path: '/transactions', policy: 'transaction.view' },
    ])

    const res = await req(app, { url: '/transactions', userId: 'alice', contextId: 'branch-1' })
    expect(res.statusCode).toBe(200)
  })

  test('null-context assignment matches null-context request', async () => {
    mock.seed({
      subjectId: 'alice',
      portal:    'branch',
      contextId: null,
      policies:  [{ name: 'branch.transaction.view', scope: null }],
    })

    const app = await buildApp(mock, 'branch', [
      { path: '/transactions', policy: 'transaction.view' },
    ])

    // No context header → context_id is undefined, treated as null
    const res = await req(app, { url: '/transactions', userId: 'alice' })
    expect(res.statusCode).toBe(200)
  })
})
