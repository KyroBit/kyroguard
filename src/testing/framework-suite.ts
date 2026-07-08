/**
 * Black-box HTTP contract for framework integrations. The makeApp harness
 * protocol is normative in docs/reference/testing.md ("The makeApp contract").
 */

import { Policy, Scope, createKyroguard, qualifyPolicyName } from '../index.js'
import { memoryAdapter } from './memory-adapter.js'
import type { Kyroguard, ResourceDefinition } from '../index.js'
import type { SuiteTestApi } from './adapter-suite.js'

export interface RouteSpec {
  method: 'GET' | 'POST'
  path: string
  domain: string
  policy?: string
  resource?: (req: any) => { type: string; id: string } | null
  getSubjectFrom?: 'header'
}

export interface TestAppResponse {
  status: number
  body: any
  headers: Record<string, string>
}

export interface TestApp {
  request(opts: {
    method: 'GET' | 'POST'
    path: string
    headers?: Record<string, string>
  }): Promise<TestAppResponse>
  close(): Promise<void>
}

export interface FrameworkSuiteOptions {
  name: string
  makeApp: (guard: Kyroguard, routes: RouteSpec[]) => Promise<TestApp>
  test: SuiteTestApi
}

export function runFrameworkContractSuite(options: FrameworkSuiteOptions): void {
  const { describe, it, expect } = options.test

  const makeResources = (): ResourceDefinition[] => [
    { type: 'thing', policies: [new Policy('thing.read'), new Policy('other.read')] },
    { type: 'doc', policies: [new Policy('docs.read', undefined, [], [Scope.owned()])] },
  ]

  const withApp = async (
    config: {
      routes: RouteSpec[]
      domains?: string[]
      seed?: (guard: Kyroguard) => Promise<void>
    },
    fn: (app: TestApp, guard: Kyroguard) => Promise<void>,
  ): Promise<void> => {
    const guard = createKyroguard({ adapter: memoryAdapter(), resources: makeResources() })
    try {
      for (const domain of config.domains ?? ['admin']) {
        await guard.sync(makeResources(), domain)
      }
      await config.seed?.(guard)
      const app = await options.makeApp(guard, config.routes)
      try {
        await fn(app, guard)
      } finally {
        await app.close()
      }
    } finally {
      guard.dispose()
    }
  }

  const route = (over: Partial<RouteSpec> = {}): RouteSpec => ({
    method: 'GET',
    path: '/thing',
    domain: 'admin',
    policy: 'thing.read',
    getSubjectFrom: 'header',
    ...over,
  })

  const docRoute = (over: Partial<RouteSpec> = {}): RouteSpec =>
    route({
      path: '/docs/d1',
      policy: 'docs.read',
      resource: () => ({ type: 'doc', id: 'd1' }),
      ...over,
    })

  const get = (
    app: TestApp,
    path: string,
    headers?: Record<string, string>,
  ): Promise<TestAppResponse> => app.request({ method: 'GET', path, headers })

  const asUser = (id: string, extra: Record<string, string> = {}): Record<string, string> => ({
    'x-subject-id': id,
    ...extra,
  })

  const grant = (
    guard: Kyroguard,
    subjectId: string,
    policy: string,
    opts: { domain?: string; tenantId?: string; scope?: string } = {},
  ): Promise<void> => {
    const domain = opts.domain ?? 'admin'
    return guard.admin.assignPolicy(
      { subjectId, domain, tenantId: opts.tenantId },
      qualifyPolicyName(domain, policy),
      opts.scope,
    )
  }

  describe(`framework integration contract: ${options.name}`, () => {
    it('1: no subject → 401 with { message, code: UNAUTHENTICATED }', () =>
      withApp({ routes: [route()] }, async app => {
        const res = await get(app, '/thing')
        expect(res.status).toBe(401)
        expect(res.body.code).toBe('UNAUTHENTICATED')
        expect(typeof res.body.message).toBe('string')
      }))

    it('2: authenticated subject without the grant → 403 ACCESS_DENIED', () =>
      withApp({ routes: [route()] }, async app => {
        const res = await get(app, '/thing', asUser('u1'))
        expect(res.status).toBe(403)
        expect(res.body.code).toBe('ACCESS_DENIED')
        expect(typeof res.body.message).toBe('string')
      }))

    it('3: granted subject → 200', () =>
      withApp(
        { routes: [route()], seed: guard => grant(guard, 'u1', 'thing.read') },
        async app => {
          const res = await get(app, '/thing', asUser('u1'))
          expect(res.status).toBe(200)
          expect(res.body.ok).toBe(true)
        },
      ))

    it('4: domain isolation — grant on domain admin does not satisfy a branch route → 403', () =>
      withApp(
        {
          domains: ['admin', 'branch'],
          routes: [route({ domain: 'branch', path: '/branch/thing' })],
          seed: guard => grant(guard, 'u1', 'thing.read', { domain: 'admin' }),
        },
        async app => {
          const res = await get(app, '/branch/thing', asUser('u1'))
          expect(res.status).toBe(403)
          expect(res.body.code).toBe('ACCESS_DENIED')
        },
      ))

    it('5: tenant isolation — a grant at tenant t1 only matches x-tenant-id: t1', () =>
      withApp(
        {
          routes: [route()],
          seed: guard => grant(guard, 'u1', 'thing.read', { tenantId: 't1' }),
        },
        async app => {
          const allowed = await get(app, '/thing', asUser('u1', { 'x-tenant-id': 't1' }))
          expect(allowed.status).toBe(200)

          const wrongTenant = await get(app, '/thing', asUser('u1', { 'x-tenant-id': 't2' }))
          expect(wrongTenant.status).toBe(403)
          expect(wrongTenant.body.code).toBe('ACCESS_DENIED')

          const noTenant = await get(app, '/thing', asUser('u1'))
          expect(noTenant.status).toBe(403)
          expect(noTenant.body.code).toBe('ACCESS_DENIED')
        },
      ))

    it('6: is_super subject → 200 without any grants', () =>
      withApp({ routes: [route()] }, async app => {
        const res = await get(app, '/thing', asUser('root', { 'x-super': '1' }))
        expect(res.status).toBe(200)
      }))

    it('7: scoped grant + resource found + scope passes → 200', () =>
      withApp(
        {
          routes: [docRoute()],
          seed: async guard => {
            await grant(guard, 'u1', 'docs.read', { scope: 'owned' })
            await guard.ownership.record('u1', { type: 'doc', id: 'd1' })
          },
        },
        async app => {
          const res = await get(app, '/docs/d1', asUser('u1'))
          expect(res.status).toBe(200)
        },
      ))

    it('8: scoped grant + scope check fails → 403 ACCESS_DENIED', () =>
      withApp(
        {
          routes: [docRoute()],
          seed: async guard => {
            await grant(guard, 'u1', 'docs.read', { scope: 'owned' })
            await guard.ownership.record('someone-else', { type: 'doc', id: 'd1' })
          },
        },
        async app => {
          const res = await get(app, '/docs/d1', asUser('u1'))
          expect(res.status).toBe(403)
          expect(res.body.code).toBe('ACCESS_DENIED')
        },
      ))

    it('9: scoped grant + resource resolver returns null → 404 NOT_FOUND', () =>
      withApp(
        {
          routes: [docRoute({ resource: () => null })],
          seed: guard => grant(guard, 'u1', 'docs.read', { scope: 'owned' }),
        },
        async app => {
          const res = await get(app, '/docs/d1', asUser('u1'))
          expect(res.status).toBe(404)
          expect(res.body.code).toBe('NOT_FOUND')
        },
      ))

    it('10: two domains on one app resolve independent subjects (per-domain subject regression)', () =>
      withApp(
        {
          domains: ['admin', 'branch'],
          routes: [
            route({ path: '/admin/thing' }),
            route({ domain: 'branch', path: '/branch/thing' }),
          ],
          seed: async guard => {
            await grant(guard, 'u1', 'thing.read', { domain: 'admin' })
            await grant(guard, 'u2', 'thing.read', { domain: 'branch' })
          },
        },
        async app => {
          expect((await get(app, '/admin/thing', asUser('u1'))).status).toBe(200)
          expect((await get(app, '/branch/thing', asUser('u2'))).status).toBe(200)
          // Registering the second domain must not clobber the first.
          expect((await get(app, '/admin/thing', asUser('u1'))).status).toBe(200)

          const crossDomain = await get(app, '/branch/thing', asUser('u1'))
          expect(crossDomain.status).toBe(403)
          expect(crossDomain.body.code).toBe('ACCESS_DENIED')
        },
      ))

    it('11: getSubject runs exactly once per request across stacked guards from one domain', () =>
      withApp(
        {
          routes: [route({ policy: 'thing.read+other.read' })],
          seed: async guard => {
            await grant(guard, 'u1', 'thing.read')
            await grant(guard, 'u1', 'other.read')
          },
        },
        async app => {
          const res = await get(app, '/thing', asUser('u1'))
          expect(res.status).toBe(200)
          expect(res.headers['x-getsubject-calls']).toBe('1')
        },
      ))

    it('12: KyroguardErrors travel the framework pipeline — x-app-hook present on 200/401/403 (reply-hijack regression)', () =>
      withApp(
        { routes: [route()], seed: guard => grant(guard, 'u1', 'thing.read') },
        async app => {
          const ok = await get(app, '/thing', asUser('u1'))
          expect(ok.status).toBe(200)
          expect(ok.headers['x-app-hook']).toBe('ran')

          const forbidden = await get(app, '/thing', asUser('u2'))
          expect(forbidden.status).toBe(403)
          expect(forbidden.body.code).toBe('ACCESS_DENIED')
          expect(forbidden.headers['x-app-hook']).toBe('ran')

          const unauthenticated = await get(app, '/thing')
          expect(unauthenticated.status).toBe(401)
          expect(unauthenticated.body.code).toBe('UNAUTHENTICATED')
          expect(unauthenticated.headers['x-app-hook']).toBe('ran')
        },
      ))

    it('13: assignGroup/removeGroup invalidate cached policy maps mid-process', () =>
      withApp(
        {
          routes: [route()],
          seed: guard =>
            guard.seedGroups(
              { editors: { label: 'Editors', policies: ['thing.read'] } },
              { domain: 'admin' },
            ),
        },
        async (app, guard) => {
          // Prime the cache with the empty policy map.
          const denied = await get(app, '/thing', asUser('u1'))
          expect(denied.status).toBe(403)

          await guard.admin.assignGroup({ subjectId: 'u1', domain: 'admin' }, 'editors')
          const allowed = await get(app, '/thing', asUser('u1'))
          expect(allowed.status).toBe(200)

          await guard.admin.removeGroup({ subjectId: 'u1', domain: 'admin' }, 'editors')
          const revoked = await get(app, '/thing', asUser('u1'))
          expect(revoked.status).toBe(403)
          expect(revoked.body.code).toBe('ACCESS_DENIED')
        },
      ))

    it('14: scoped grant + :id route + no resource option → params.id is the row target', () =>
      withApp(
        {
          routes: [docRoute({ path: '/docs/:id', resource: undefined })],
          seed: async guard => {
            await grant(guard, 'u1', 'docs.read', { scope: 'owned' })
            await guard.ownership.record('u1', { type: 'doc', id: 'd1' })
            await guard.ownership.record('someone-else', { type: 'doc', id: 'd2' })
          },
        },
        async app => {
          expect((await get(app, '/docs/d1', asUser('u1'))).status).toBe(200)

          const foreign = await get(app, '/docs/d2', asUser('u1'))
          expect(foreign.status).toBe(403)
          expect(foreign.body.code).toBe('ACCESS_DENIED')
        },
      ))

    it('15: scoped grant + no :id and no resource option → row scope fails closed', () =>
      withApp(
        {
          routes: [docRoute({ path: '/docs-inbox', resource: undefined })],
          seed: async guard => {
            await grant(guard, 'u1', 'docs.read', { scope: 'owned' })
            await guard.ownership.record('u1', { type: 'doc', id: 'd1' })
          },
        },
        async app => {
          const res = await get(app, '/docs-inbox', asUser('u1'))
          expect(res.status).toBe(403)
          expect(res.body.code).toBe('ACCESS_DENIED')
        },
      ))

    it('16: explicit resource option wins over params.id', () =>
      withApp(
        {
          routes: [docRoute({ path: '/docs/:id', resource: () => ({ type: 'doc', id: 'd9' }) })],
          seed: async guard => {
            await grant(guard, 'u1', 'docs.read', { scope: 'owned' })
            await guard.ownership.record('u1', { type: 'doc', id: 'd9' })
          },
        },
        async app => {
          // u1 owns d9 but not d1 — a 200 proves the explicit resolver decided.
          expect((await get(app, '/docs/d1', asUser('u1'))).status).toBe(200)
        },
      ))

    it('17: unscoped grant on a :id route → 200 with no ownership recorded', () =>
      withApp(
        {
          routes: [docRoute({ path: '/docs/:id', resource: undefined })],
          seed: guard => grant(guard, 'u1', 'docs.read'),
        },
        async app => {
          expect((await get(app, '/docs/d2', asUser('u1'))).status).toBe(200)
        },
      ))
  })
}
