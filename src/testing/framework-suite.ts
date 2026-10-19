/**
 * Black-box HTTP contract for framework integrations. The makeApp harness
 * protocol is normative in docs/reference/testing.md ("The makeApp contract").
 */

import { Policy, Scope, createGuard, qualifyPolicyName, toSubjectRef } from '../index.js'
import { memoryAdapter } from './memory-adapter.js'
import type { Guard, ResourceDefinition } from '../index.js'
import type { SuiteTestApi } from './adapter-suite.js'

export interface RouteSpec {
  method: 'GET' | 'POST'
  path: string
  domain: string
  policy?: string
  getSubjectFrom?: 'header'
  /**
   * The harness must NOT install requirePolicy on these routes: 'can' answers
   * `{ can }` for `policy`, 'grants' answers the grant map, and 'groups' answers
   * `{ groups }`, the names of the groups held by the member named in the
   * `x-member-id` header (tenant `x-member-tenant`). All always 200.
   */
  answers?: 'can' | 'grants' | 'groups'
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
  makeApp: (guard: Guard, routes: RouteSpec[]) => Promise<TestApp>
  test: SuiteTestApi
}

export function runFrameworkContractSuite(options: FrameworkSuiteOptions): void {
  const { describe, it, expect } = options.test

  const makeResources = (): ResourceDefinition[] => [
    { type: 'thing', policies: [new Policy('thing.read'), new Policy('other.read')] },
    {
      type: 'doc',
      policies: [
        new Policy('docs.read', undefined, [], [
          new Scope('none', 'Nothing at all', () => false),
        ]),
      ],
    },
  ]

  const withApp = async (
    config: {
      routes: RouteSpec[]
      domains?: string[]
      seed?: (guard: Guard) => Promise<void>
    },
    fn: (app: TestApp, guard: Guard) => Promise<void>,
  ): Promise<void> => {
    const guard = createGuard({ adapter: memoryAdapter(), resources: makeResources() })
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
    route({ path: '/docs/d1', policy: 'docs.read', ...over })

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
    guard: Guard,
    subjectId: string,
    policy: string,
    opts: { domain?: string; tenantId?: string; scope?: string } = {},
  ): Promise<void> => {
    const domain = opts.domain ?? 'admin'
    return guard.engine.assignPolicy(
      toSubjectRef({ id: subjectId, domain, tenant_id: opts.tenantId }),
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

    it('7: scoped grant → 200; the scope narrows the query, it does not refuse the request', () =>
      withApp(
        {
          routes: [docRoute()],
          seed: guard => grant(guard, 'u1', 'docs.read', { scope: 'none' }),
        },
        async app => {
          const res = await get(app, '/docs/d1', asUser('u1'))
          expect(res.status).toBe(200)
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

    it('12: GuardErrors travel the framework pipeline — x-app-hook present on 200/401/403 (reply-hijack regression)', () =>
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

          await guard.engine.assignGroup(toSubjectRef({ id: 'u1', domain: 'admin' }), 'editors')
          const allowed = await get(app, '/thing', asUser('u1'))
          expect(allowed.status).toBe(200)

          await guard.engine.removeGroup(toSubjectRef({ id: 'u1', domain: 'admin' }), 'editors')
          const revoked = await get(app, '/thing', asUser('u1'))
          expect(revoked.status).toBe(403)
          expect(revoked.body.code).toBe('ACCESS_DENIED')
        },
      ))

    const canRoute = (over: Partial<RouteSpec> = {}): RouteSpec =>
      route({ path: '/can/thing', answers: 'can', ...over })

    const grantsRoute = (over: Partial<RouteSpec> = {}): RouteSpec =>
      route({ path: '/grants', answers: 'grants', policy: undefined, ...over })

    it('14: can() answers false for an unauthenticated request — it never 401s', () =>
      withApp({ routes: [canRoute()] }, async app => {
        const res = await get(app, '/can/thing')
        expect(res.status).toBe(200)
        expect(res.body.can).toBe(false)
      }))

    it('15: can() answers false for an authenticated subject without the grant', () =>
      withApp({ routes: [canRoute()] }, async app => {
        const res = await get(app, '/can/thing', asUser('u1'))
        expect(res.status).toBe(200)
        expect(res.body.can).toBe(false)
      }))

    it('16: can() answers true for a granted subject', () =>
      withApp(
        { routes: [canRoute()], seed: guard => grant(guard, 'u1', 'thing.read') },
        async app => {
          const res = await get(app, '/can/thing', asUser('u1'))
          expect(res.body.can).toBe(true)
        },
      ))

    it('17: can() answers true for a scoped grant — a scoped grant is still a grant', () =>
      withApp(
        {
          routes: [canRoute({ path: '/can/docs', policy: 'docs.read' })],
          seed: guard => grant(guard, 'u1', 'docs.read', { scope: 'none' }),
        },
        async app => {
          const res = await get(app, '/can/docs', asUser('u1'))
          expect(res.body.can).toBe(true)
        },
      ))

    it('18: can() answers true for is_super without any grants', () =>
      withApp({ routes: [canRoute()] }, async app => {
        const res = await get(app, '/can/thing', asUser('root', { 'x-super': '1' }))
        expect(res.body.can).toBe(true)
      }))

    it('19: can() respects domain isolation — an admin grant does not answer for branch', () =>
      withApp(
        {
          domains: ['admin', 'branch'],
          routes: [canRoute({ domain: 'branch', path: '/can/branch-thing' })],
          seed: guard => grant(guard, 'u1', 'thing.read', { domain: 'admin' }),
        },
        async app => {
          const res = await get(app, '/can/branch-thing', asUser('u1'))
          expect(res.body.can).toBe(false)
        },
      ))

    it('20: grantsFor() answers unqualified policy names, null for unrestricted and the scope names otherwise', () =>
      withApp(
        {
          routes: [grantsRoute()],
          seed: async guard => {
            await grant(guard, 'u1', 'thing.read')
            await grant(guard, 'u1', 'docs.read', { scope: 'none' })
          },
        },
        async app => {
          const res = await get(app, '/grants', asUser('u1'))
          expect(res.status).toBe(200)
          expect(res.body).toEqual({ 'thing.read': null, 'docs.read': ['none'] })
        },
      ))

    it('21: grantsFor() answers an empty object for an unauthenticated request', () =>
      withApp({ routes: [grantsRoute()] }, async app => {
        const res = await get(app, '/grants')
        expect(res.status).toBe(200)
        expect(res.body).toEqual({})
      }))

    it('22: grantsFor() answers every policy in the domain, unrestricted, for is_super', () =>
      withApp({ routes: [grantsRoute()] }, async app => {
        const res = await get(app, '/grants', asUser('root', { 'x-super': '1' }))
        expect(res.body).toEqual({ 'thing.read': null, 'other.read': null, 'docs.read': null })
      }))

    it('23: grantsFor() answers only this domain, never another domain’s grants', () =>
      withApp(
        {
          domains: ['admin', 'branch'],
          routes: [grantsRoute({ domain: 'branch', path: '/grants/branch' })],
          seed: async guard => {
            await grant(guard, 'u1', 'thing.read', { domain: 'admin' })
            await grant(guard, 'u1', 'other.read', { domain: 'branch' })
          },
        },
        async app => {
          const res = await get(app, '/grants/branch', asUser('u1'))
          expect(res.body).toEqual({ 'other.read': null })
        },
      ))

    const groupsRoute = (over: Partial<RouteSpec> = {}): RouteSpec =>
      route({ path: '/groups', answers: 'groups', policy: undefined, ...over })

    const member = (id: string, tenantId?: string): Record<string, string> => ({
      'x-member-id': id,
      ...(tenantId ? { 'x-member-tenant': tenantId } : {}),
    })

    const seedEditors = async (guard: Guard): Promise<void> => {
      await guard.seedGroups(
        { editors: { label: 'Editors', policies: ['thing.read'] } },
        { domain: 'admin' },
      )
    }

    it('24: groupsOf() names the groups a member belongs to in this domain', () =>
      withApp(
        {
          routes: [groupsRoute()],
          seed: async guard => {
            await seedEditors(guard)
            await guard.engine.assignGroup(toSubjectRef({ id: 'u1', domain: 'admin' }), 'editors')
          },
        },
        async app => {
          const res = await get(app, '/groups', member('u1'))
          expect(res.status).toBe(200)
          expect(res.body).toEqual({ groups: ['editors'] })
        },
      ))

    it('25: groupsOf() names nothing for someone who belongs to no group', () =>
      withApp({ routes: [groupsRoute()], seed: seedEditors }, async app => {
        const res = await get(app, '/groups', member('u1'))
        expect(res.body).toEqual({ groups: [] })
      }))

    it('26: groupsOf() answers only this domain, never another domain’s membership', () =>
      withApp(
        {
          domains: ['admin', 'branch'],
          routes: [groupsRoute({ domain: 'branch', path: '/groups/branch' })],
          seed: async guard => {
            await seedEditors(guard)
            await guard.engine.assignGroup(toSubjectRef({ id: 'u1', domain: 'admin' }), 'editors')
          },
        },
        async app => {
          const res = await get(app, '/groups/branch', member('u1'))
          expect(res.body).toEqual({ groups: [] })
        },
      ))

    it('27: groupsOf() matches the tenant, so one tenant never sees another’s membership', () =>
      withApp(
        {
          routes: [groupsRoute()],
          seed: async guard => {
            await seedEditors(guard)
            await guard.engine.assignGroup(
              toSubjectRef({ id: 'u1', domain: 'admin', tenant_id: 'b1' }),
              'editors',
            )
          },
        },
        async app => {
          expect((await get(app, '/groups', member('u1', 'b2'))).body).toEqual({ groups: [] })
          expect((await get(app, '/groups', member('u1', 'b1'))).body).toEqual({
            groups: ['editors'],
          })
        },
      ))
  })
}
