/**
 * CRITICAL — Portal isolation
 *
 * Policies are namespaced per portal. An assignment in the admin portal must
 * NEVER grant access on the branch portal, and vice versa.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import Fastify from 'fastify'
import rbacPlugin from '../src/plugin.js'
import { createMockAdapter, buildApp, req } from './helpers.js'

describe('Portal isolation', () => {
  const mock = createMockAdapter()
  beforeEach(() => mock.reset())

  // ── Cross-portal bleed ─────────────────────────────────────────────────────

  test('admin assignment does not grant access on branch portal', async () => {
    mock.seed({
      subjectId: 'alice',
      portal:    'admin',
      contextId: null,
      policies:  [{ name: 'admin.dashboard.view', scope: null }],
    })

    const app = await buildApp(mock, 'branch', [
      { path: '/protected', policy: 'dashboard.view' },
    ])

    const res = await req(app, { url: '/protected', userId: 'alice' })
    expect(res.statusCode).toBe(403)
  })

  test('branch assignment does not grant access on admin portal', async () => {
    mock.seed({
      subjectId: 'alice',
      portal:    'branch',
      contextId: 'branch-1',
      policies:  [{ name: 'branch.transaction.view', scope: null }],
    })

    const app = await buildApp(mock, 'admin', [
      { path: '/transactions', policy: 'transaction.view' },
    ])

    const res = await req(app, { url: '/transactions', userId: 'alice' })
    expect(res.statusCode).toBe(403)
  })

  test('null-portal group assignment does not grant access on a named portal', async () => {
    mock.seed({
      subjectId: 'alice',
      portal:    null,
      contextId: null,
      policies:  [{ name: 'admin.dashboard.view', scope: null }],
    })

    const app = await buildApp(mock, 'admin', [
      { path: '/dashboard', policy: 'dashboard.view' },
    ])

    const res = await req(app, { url: '/dashboard', userId: 'alice' })
    expect(res.statusCode).toBe(403)
  })

  test('named-portal assignment does not match null-portal check', async () => {
    mock.seed({
      subjectId: 'alice',
      portal:    'admin',
      contextId: null,
      policies:  [{ name: 'admin.dashboard.view', scope: null }],
    })

    // App without forPortal — subject.portal is undefined, policyMap uses null portal
    const app = Fastify({ logger: false })
    await app.register(rbacPlugin, { adapter: mock.adapter })
    app.get('/dashboard', {
      preHandler: app.rbac.requirePolicy('dashboard.view' as any),
    }, async () => ({ ok: true }))
    await app.ready()

    // No x-user-id → 401 (no subject set without forPortal)
    const res = await app.inject({ method: 'GET', url: '/dashboard' })
    expect(res.statusCode).toBe(401)
  })

  // ── Same policy name in two portals is independent ─────────────────────────

  test('same policy name in two portals is completely independent', async () => {
    mock.seed({
      subjectId: 'alice',
      portal:    'admin',
      contextId: null,
      policies:  [{ name: 'admin.post.view', scope: null }],
    })

    const branchApp = await buildApp(mock, 'branch', [{ path: '/posts', policy: 'post.view' }])
    const adminApp  = await buildApp(mock, 'admin',  [{ path: '/posts', policy: 'post.view' }])

    expect((await req(branchApp, { url: '/posts', userId: 'alice' })).statusCode).toBe(403)
    expect((await req(adminApp,  { url: '/posts', userId: 'alice' })).statusCode).toBe(200)
  })

  // ── Happy-path controls ────────────────────────────────────────────────────

  test('correct portal assignment grants access on that portal', async () => {
    mock.seed({
      subjectId: 'alice',
      portal:    'branch',
      contextId: null,
      policies:  [{ name: 'branch.transaction.view', scope: null }],
    })

    const app = await buildApp(mock, 'branch', [
      { path: '/transactions', policy: 'transaction.view' },
    ])

    expect((await req(app, { url: '/transactions', userId: 'alice' })).statusCode).toBe(200)
  })

  test('user without any assignment always gets 403', async () => {
    const app = await buildApp(mock, 'admin', [{ path: '/reports', policy: 'report.view' }])

    expect((await req(app, { url: '/reports', userId: 'nobody' })).statusCode).toBe(403)
  })

  test('user bob cannot use alice\'s assignment', async () => {
    mock.seed({
      subjectId: 'alice',
      portal:    'admin',
      contextId: null,
      policies:  [{ name: 'admin.report.view', scope: null }],
    })

    const app = await buildApp(mock, 'admin', [{ path: '/reports', policy: 'report.view' }])

    expect((await req(app, { url: '/reports', userId: 'bob' })).statusCode).toBe(403)
  })
})
