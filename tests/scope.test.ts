/**
 * Scope checks
 *
 * When a policy is assigned with a scope string (not null), the scope's check
 * function decides whether to allow or deny the request. The route must provide
 * a resource resolver.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import Fastify from 'fastify'
import rbacPlugin from '../src/plugin.js'
import { Scope } from '../src/scope.js'
import { Policy } from '../src/policy.js'
import { RBAC_SCOPES } from '../src/proxy.js'
import { createMockAdapter, req } from './helpers.js'

describe('Scope checks', () => {
  const mock = createMockAdapter()
  beforeEach(() => mock.reset())

  function buildScopeApp(scopes: Scope[], policy: string, resourceFn: (() => any) | null) {
    const db = { [RBAC_SCOPES]: scopes }

    return (async () => {
      const app = Fastify({ logger: false })
      await app.register(rbacPlugin, { adapter: mock.adapter, db })

      const rbac = app.rbac.forPortal('portal' as any, (r) => ({
        id:        (r.headers['x-user-id'] as string) ?? '',
        context_id: (r.headers['x-context-id'] as string) || undefined,
      }))

      app.get('/action', {
        preHandler: rbac.requirePolicy(policy as any, resourceFn !== null ? {
          resource: resourceFn,
        } : undefined),
      }, async () => ({ ok: true }))

      await app.ready()
      return app
    })()
  }

  test('scope check returns true → 200', async () => {
    const alwaysAllow = new Scope('allow', 'Allow', () => true)

    mock.seed({
      subjectId: 'alice',
      portal:    'portal',
      contextId: null,
      policies:  [{ name: 'portal.post.update', scope: 'allow' }],
    })

    const app = await buildScopeApp(
      [alwaysAllow],
      'post.update',
      () => ({ type: 'post', id: 'post-1' }),
    )

    const res = await req(app, { url: '/action', userId: 'alice' })
    expect(res.statusCode).toBe(200)
  })

  test('scope check returns false → 403', async () => {
    const alwaysDeny = new Scope('deny', 'Deny', () => false)

    mock.seed({
      subjectId: 'alice',
      portal:    'portal',
      contextId: null,
      policies:  [{ name: 'portal.post.update', scope: 'deny' }],
    })

    const app = await buildScopeApp(
      [alwaysDeny],
      'post.update',
      () => ({ type: 'post', id: 'post-1' }),
    )

    const res = await req(app, { url: '/action', userId: 'alice' })
    expect(res.statusCode).toBe(403)
  })

  test('scope active but no resource resolver provided → 403', async () => {
    const allowScope = new Scope('allow', 'Allow', () => true)

    mock.seed({
      subjectId: 'alice',
      portal:    'portal',
      contextId: null,
      policies:  [{ name: 'portal.post.update', scope: 'allow' }],
    })

    // No resource resolver (null)
    const app = await buildScopeApp([allowScope], 'post.update', null)

    const res = await req(app, { url: '/action', userId: 'alice' })
    expect(res.statusCode).toBe(403)
  })

  test('resource resolver returns null → 404', async () => {
    const allowScope = new Scope('allow', 'Allow', () => true)

    mock.seed({
      subjectId: 'alice',
      portal:    'portal',
      contextId: null,
      policies:  [{ name: 'portal.post.update', scope: 'allow' }],
    })

    const app = await buildScopeApp([allowScope], 'post.update', () => null)

    const res = await req(app, { url: '/action', userId: 'alice' })
    expect(res.statusCode).toBe(404)
  })

  test('scope name not found in registered scopes → 403', async () => {
    // Policy has scope 'missing-scope' but no Scope object is registered
    mock.seed({
      subjectId: 'alice',
      portal:    'portal',
      contextId: null,
      policies:  [{ name: 'portal.post.update', scope: 'missing-scope' }],
    })

    const app = await buildScopeApp(
      [], // no scopes registered
      'post.update',
      () => ({ type: 'post', id: 'post-1' }),
    )

    const res = await req(app, { url: '/action', userId: 'alice' })
    expect(res.statusCode).toBe(403)
  })

  test('scope check receives correct subject and resource', async () => {
    let capturedSubject: any = null
    let capturedResource: any = null

    const captureScope = new Scope('capture', 'Capture', (subject, resource) => {
      capturedSubject  = subject
      capturedResource = resource
      return true
    })

    mock.seed({
      subjectId: 'alice',
      portal:    'portal',
      contextId: 'ctx-1',
      policies:  [{ name: 'portal.post.update', scope: 'capture' }],
    })

    const app = await buildScopeApp(
      [captureScope],
      'post.update',
      () => ({ type: 'post', id: 'post-42' }),
    )

    await req(app, { url: '/action', userId: 'alice', contextId: 'ctx-1' })

    expect(capturedSubject?.id).toBe('alice')
    expect(capturedResource?.type).toBe('post')
    expect(capturedResource?.id).toBe('post-42')
  })

  test('async scope check is awaited correctly', async () => {
    const asyncScope = new Scope('async-allow', 'Async', async () => {
      await new Promise(r => setTimeout(r, 10))
      return true
    })

    mock.seed({
      subjectId: 'alice',
      portal:    'portal',
      contextId: null,
      policies:  [{ name: 'portal.post.update', scope: 'async-allow' }],
    })

    const app = await buildScopeApp(
      [asyncScope],
      'post.update',
      () => ({ type: 'post', id: 'post-1' }),
    )

    const res = await req(app, { url: '/action', userId: 'alice' })
    expect(res.statusCode).toBe(200)
  })

  test('RBAC_SCOPES symbol on db auto-registers scopes for the plugin', async () => {
    const ownScope = new Scope('own-record', 'Own Record', () => true)
    const policy   = new Policy('post.update', 'Update', [], [ownScope])

    // Simulate what createTrackedDb stores via symbol
    const fakeDb = { [RBAC_SCOPES]: [ownScope] }

    mock.seed({
      subjectId: 'alice',
      portal:    'portal',
      contextId: null,
      policies:  [{ name: 'portal.post.update', scope: 'own-record' }],
    })

    const app = Fastify({ logger: false })
    await app.register(rbacPlugin, { adapter: mock.adapter, db: fakeDb })

    const rbac = app.rbac.forPortal('portal' as any, (r) => ({
      id: (r.headers['x-user-id'] as string) ?? '',
    }))

    app.get('/action', {
      preHandler: rbac.requirePolicy('post.update' as any, {
        resource: () => ({ type: 'post', id: 'p1' }),
      }),
    }, async () => ({ ok: true }))

    await app.ready()

    const res = await req(app, { url: '/action', userId: 'alice' })
    expect(res.statusCode).toBe(200)
  })
})
