/**
 * Policy enforcement — response codes and basic flow
 *
 * Covers: 401 (no subject), 403 (policy absent), 200 (policy present),
 * is_super bypass, and direct-policy assignment.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { createMockAdapter, buildApp, req } from './helpers.js'

describe('Policy enforcement', () => {
  const mock = createMockAdapter()
  beforeEach(() => mock.reset())

  // ── 401 Unauthorized ──────────────────────────────────────────────────────

  test('returns 401 when no user id is present', async () => {
    const app = await buildApp(mock, 'admin', [{ path: '/secure', policy: 'post.view' }])

    const res = await app.inject({ method: 'GET', url: '/secure' })
    expect(res.statusCode).toBe(401)
  })

  test('returns 401 when x-user-id is an empty string', async () => {
    const app = await buildApp(mock, 'admin', [{ path: '/secure', policy: 'post.view' }])

    const res = await app.inject({
      method:  'GET',
      url:     '/secure',
      headers: { 'x-user-id': '' },
    })
    expect(res.statusCode).toBe(401)
  })

  // ── 403 Forbidden ─────────────────────────────────────────────────────────

  test('returns 403 when user has no policies at all', async () => {
    const app = await buildApp(mock, 'admin', [{ path: '/secure', policy: 'post.view' }])

    const res = await req(app, { url: '/secure', userId: 'alice' })
    expect(res.statusCode).toBe(403)
  })

  test('returns 403 when user has other policies but not the required one', async () => {
    mock.seed({
      subjectId: 'alice',
      portal:    'admin',
      contextId: null,
      policies:  [{ name: 'admin.post.create', scope: null }],
    })

    const app = await buildApp(mock, 'admin', [{ path: '/delete', policy: 'post.delete' }])

    const res = await req(app, { url: '/delete', userId: 'alice' })
    expect(res.statusCode).toBe(403)
  })

  // ── 200 OK ────────────────────────────────────────────────────────────────

  test('returns 200 when user has the required policy (no scope)', async () => {
    mock.seed({
      subjectId: 'alice',
      portal:    'admin',
      contextId: null,
      policies:  [{ name: 'admin.post.view', scope: null }],
    })

    const app = await buildApp(mock, 'admin', [{ path: '/posts', policy: 'post.view' }])

    const res = await req(app, { url: '/posts', userId: 'alice' })
    expect(res.statusCode).toBe(200)
  })

  test('returns 200 when user has multiple policies and the right one is present', async () => {
    mock.seed({
      subjectId: 'alice',
      portal:    'admin',
      contextId: null,
      policies:  [
        { name: 'admin.post.view',   scope: null },
        { name: 'admin.post.create', scope: null },
        { name: 'admin.post.delete', scope: null },
      ],
    })

    const app = await buildApp(mock, 'admin', [
      { path: '/view',   policy: 'post.view'   },
      { path: '/create', policy: 'post.create' },
      { path: '/delete', policy: 'post.delete' },
    ])

    expect((await req(app, { url: '/view',   userId: 'alice' })).statusCode).toBe(200)
    expect((await req(app, { url: '/create', userId: 'alice' })).statusCode).toBe(200)
    expect((await req(app, { url: '/delete', userId: 'alice' })).statusCode).toBe(200)
  })

  // ── is_super bypass ───────────────────────────────────────────────────────

  test('is_super=true bypasses all policy checks', async () => {
    // No assignments — super user should still pass
    const app = await buildApp(mock, 'admin', [
      { path: '/anything', policy: 'admin.super.secret' as any },
    ])

    const res = await req(app, { url: '/anything', userId: 'god', isSuper: true })
    expect(res.statusCode).toBe(200)
  })

  test('is_super=false is not a bypass', async () => {
    const app = await buildApp(mock, 'admin', [{ path: '/secure', policy: 'post.view' }])

    const res = await req(app, { url: '/secure', userId: 'alice', isSuper: false })
    expect(res.statusCode).toBe(403)
  })

  test('is_super=true bypasses check even when user has a conflicting denial in policy map', async () => {
    // Edge case: super user IS in the DB but with restricted policies
    mock.seed({
      subjectId: 'superuser',
      portal:    'admin',
      contextId: null,
      policies:  [{ name: 'admin.post.view', scope: 'own-post' }],
    })

    const app = await buildApp(mock, 'admin', [
      { path: '/delete', policy: 'post.delete' },
    ])

    const res = await req(app, { url: '/delete', userId: 'superuser', isSuper: true })
    expect(res.statusCode).toBe(200)
  })

  // ── Direct-policy assignment ───────────────────────────────────────────────

  test('direct-policy assignment grants access without a group', async () => {
    // Direct assignments are not portal-filtered — they apply across portals
    mock.seedDirect('alice', 'admin.post.view', null)

    const app = await buildApp(mock, 'admin', [{ path: '/posts', policy: 'post.view' }])

    const res = await req(app, { url: '/posts', userId: 'alice' })
    expect(res.statusCode).toBe(200)
  })

  // ── null (unrestricted) wins over scope ───────────────────────────────────

  test('when user has same policy twice (scoped + unscoped), null scope wins', async () => {
    // Group assignment with scope, direct assignment without — null should win
    mock.seed({
      subjectId: 'alice',
      portal:    'admin',
      contextId: null,
      policies:  [{ name: 'admin.post.update', scope: 'own-post' }],
    })
    mock.seedDirect('alice', 'admin.post.update', null)

    const app = await buildApp(mock, 'admin', [
      // No resource resolver — would 403 if scope were active
      { path: '/update', policy: 'post.update' },
    ])

    const res = await req(app, { url: '/update', userId: 'alice' })
    expect(res.statusCode).toBe(200) // null won, no scope check triggered
  })
})
