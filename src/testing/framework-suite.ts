/**
 * Black-box HTTP contract for framework integrations (Fastify, Express,
 * future adapters). The suite builds its own rbac instances on memoryAdapter()
 * and seeds grants per case; the integration under test only has to translate
 * RouteSpec[] into a running app.
 *
 * ── Harness protocol — every makeApp implementation MUST ────────────────────
 * 1. Create ONE domain per distinct `route.domain` via the integration's
 *    domain factory. When `getSubjectFrom === 'header'`, getSubject reads:
 *      x-subject-id   → subject id; absent or empty → return null (→ 401)
 *      x-tenant-id    → tenant_id, when present
 *      x-super: '1'   → is_super: true
 *    getSubject must count its own invocations per request, and every
 *    response must carry the header `x-getsubject-calls` with that request's
 *    total (proves guard-time memoization).
 * 2. Mount each route at (method, path). When `policy` is set, attach one
 *    requirePolicy guard per '+'-separated UNQUALIFIED policy name (the
 *    domain qualifies), forwarding `resource` when provided. The success
 *    handler responds 200 with JSON `{ ok: true }`.
 * 3. Register a framework-level hook/middleware that adds the header
 *    `x-app-hook: ran` to EVERY response, including error responses —
 *    RbacErrors must travel the framework's own pipeline, never a hijacked
 *    reply (v0 regression).
 * 4. TestApp.request results use lowercase header names and a parsed JSON
 *    body.
 */

import { Policy, Scope, createRbac, qualifyPolicyName } from '../index.js'
import { memoryAdapter } from './memory-adapter.js'
import type { Rbac, ResourceDefinition } from '../index.js'
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
  makeApp: (rbac: Rbac, routes: RouteSpec[]) => Promise<TestApp>
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
      seed?: (rbac: Rbac) => Promise<void>
    },
    fn: (app: TestApp, rbac: Rbac) => Promise<void>,
  ): Promise<void> => {
    const rbac = createRbac({ adapter: memoryAdapter(), resources: makeResources() })
    try {
      for (const domain of config.domains ?? ['admin']) {
        await rbac.sync(makeResources(), domain)
      }
      await config.seed?.(rbac)
      const app = await options.makeApp(rbac, config.routes)
      try {
        await fn(app, rbac)
      } finally {
        await app.close()
      }
    } finally {
      rbac.dispose()
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
    rbac: Rbac,
    subjectId: string,
    policy: string,
    opts: { domain?: string; tenantId?: string; scope?: string | null } = {},
  ): Promise<void> => {
    const domain = opts.domain ?? 'admin'
    return rbac.admin.assignPolicy(
      { subjectId, domain, tenantId: opts.tenantId },
      qualifyPolicyName(domain, policy),
      opts.scope,
    )
  }

  describe(`framework integration contract: ${options.name}`, () => {
    it('1: no subject → 401 with { message, code: RBAC_UNAUTHENTICATED }', () =>
      withApp({ routes: [route()] }, async app => {
        const res = await get(app, '/thing')
        expect(res.status).toBe(401)
        expect(res.body.code).toBe('RBAC_UNAUTHENTICATED')
        expect(typeof res.body.message).toBe('string')
      }))

    it('2: authenticated subject without the grant → 403 RBAC_POLICY_DENIED', () =>
      withApp({ routes: [route()] }, async app => {
        const res = await get(app, '/thing', asUser('u1'))
        expect(res.status).toBe(403)
        expect(res.body.code).toBe('RBAC_POLICY_DENIED')
        expect(typeof res.body.message).toBe('string')
      }))

    it('3: granted subject → 200', () =>
      withApp(
        { routes: [route()], seed: rbac => grant(rbac, 'u1', 'thing.read') },
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
          seed: rbac => grant(rbac, 'u1', 'thing.read', { domain: 'admin' }),
        },
        async app => {
          const res = await get(app, '/branch/thing', asUser('u1'))
          expect(res.status).toBe(403)
          expect(res.body.code).toBe('RBAC_POLICY_DENIED')
        },
      ))

    it('5: tenant isolation — a grant at tenant t1 only matches x-tenant-id: t1', () =>
      withApp(
        {
          routes: [route()],
          seed: rbac => grant(rbac, 'u1', 'thing.read', { tenantId: 't1' }),
        },
        async app => {
          const allowed = await get(app, '/thing', asUser('u1', { 'x-tenant-id': 't1' }))
          expect(allowed.status).toBe(200)

          const wrongTenant = await get(app, '/thing', asUser('u1', { 'x-tenant-id': 't2' }))
          expect(wrongTenant.status).toBe(403)
          expect(wrongTenant.body.code).toBe('RBAC_POLICY_DENIED')

          const noTenant = await get(app, '/thing', asUser('u1'))
          expect(noTenant.status).toBe(403)
          expect(noTenant.body.code).toBe('RBAC_POLICY_DENIED')
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
          seed: async rbac => {
            await grant(rbac, 'u1', 'docs.read', { scope: 'owned' })
            await rbac.ownership.record('u1', { type: 'doc', id: 'd1' })
          },
        },
        async app => {
          const res = await get(app, '/docs/d1', asUser('u1'))
          expect(res.status).toBe(200)
        },
      ))

    it('8: scoped grant + scope check fails → 403 RBAC_SCOPE_DENIED', () =>
      withApp(
        {
          routes: [docRoute()],
          seed: async rbac => {
            await grant(rbac, 'u1', 'docs.read', { scope: 'owned' })
            await rbac.ownership.record('someone-else', { type: 'doc', id: 'd1' })
          },
        },
        async app => {
          const res = await get(app, '/docs/d1', asUser('u1'))
          expect(res.status).toBe(403)
          expect(res.body.code).toBe('RBAC_SCOPE_DENIED')
        },
      ))

    it('9: scoped grant + resource resolver returns null → 404 RBAC_RESOURCE_NOT_FOUND', () =>
      withApp(
        {
          routes: [docRoute({ resource: () => null })],
          seed: rbac => grant(rbac, 'u1', 'docs.read', { scope: 'owned' }),
        },
        async app => {
          const res = await get(app, '/docs/d1', asUser('u1'))
          expect(res.status).toBe(404)
          expect(res.body.code).toBe('RBAC_RESOURCE_NOT_FOUND')
        },
      ))

    it('10: two domains on one app resolve independent subjects (v0 forDomain regression)', () =>
      withApp(
        {
          domains: ['admin', 'branch'],
          routes: [
            route({ path: '/admin/thing' }),
            route({ domain: 'branch', path: '/branch/thing' }),
          ],
          seed: async rbac => {
            await grant(rbac, 'u1', 'thing.read', { domain: 'admin' })
            await grant(rbac, 'u2', 'thing.read', { domain: 'branch' })
          },
        },
        async app => {
          expect((await get(app, '/admin/thing', asUser('u1'))).status).toBe(200)
          expect((await get(app, '/branch/thing', asUser('u2'))).status).toBe(200)
          // Registering the second domain must not clobber the first.
          expect((await get(app, '/admin/thing', asUser('u1'))).status).toBe(200)

          const crossDomain = await get(app, '/branch/thing', asUser('u1'))
          expect(crossDomain.status).toBe(403)
          expect(crossDomain.body.code).toBe('RBAC_POLICY_DENIED')
        },
      ))

    it('11: getSubject runs exactly once per request across stacked guards from one domain', () =>
      withApp(
        {
          routes: [route({ policy: 'thing.read+other.read' })],
          seed: async rbac => {
            await grant(rbac, 'u1', 'thing.read')
            await grant(rbac, 'u1', 'other.read')
          },
        },
        async app => {
          const res = await get(app, '/thing', asUser('u1'))
          expect(res.status).toBe(200)
          expect(res.headers['x-getsubject-calls']).toBe('1')
        },
      ))

    it('12: RbacErrors travel the framework pipeline — x-app-hook present on 200/401/403 (v0 reply-hijack regression)', () =>
      withApp(
        { routes: [route()], seed: rbac => grant(rbac, 'u1', 'thing.read') },
        async app => {
          const ok = await get(app, '/thing', asUser('u1'))
          expect(ok.status).toBe(200)
          expect(ok.headers['x-app-hook']).toBe('ran')

          const forbidden = await get(app, '/thing', asUser('u2'))
          expect(forbidden.status).toBe(403)
          expect(forbidden.body.code).toBe('RBAC_POLICY_DENIED')
          expect(forbidden.headers['x-app-hook']).toBe('ran')

          const unauthenticated = await get(app, '/thing')
          expect(unauthenticated.status).toBe(401)
          expect(unauthenticated.body.code).toBe('RBAC_UNAUTHENTICATED')
          expect(unauthenticated.headers['x-app-hook']).toBe('ran')
        },
      ))

    it('13: assignGroup/removeGroup invalidate cached policy maps mid-process', () =>
      withApp(
        {
          routes: [route()],
          seed: rbac =>
            rbac.seedGroups(
              { editors: { label: 'Editors', policies: ['thing.read'] } },
              { domain: 'admin' },
            ),
        },
        async (app, rbac) => {
          // Prime the cache with the empty policy map.
          const denied = await get(app, '/thing', asUser('u1'))
          expect(denied.status).toBe(403)

          await rbac.admin.assignGroup({ subjectId: 'u1', domain: 'admin' }, 'editors')
          const allowed = await get(app, '/thing', asUser('u1'))
          expect(allowed.status).toBe(200)

          await rbac.admin.removeGroup({ subjectId: 'u1', domain: 'admin' }, 'editors')
          const revoked = await get(app, '/thing', asUser('u1'))
          expect(revoked.status).toBe(403)
          expect(revoked.body.code).toBe('RBAC_POLICY_DENIED')
        },
      ))
  })
}
