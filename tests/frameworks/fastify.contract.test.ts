/**
 * Runs the black-box framework contract suite (src/testing/framework-suite.ts)
 * against the Fastify integration using app.inject() — no sockets.
 *
 * The x-app-hook header is added via a plain onSend hook, which only runs for
 * responses that travel Fastify's real pipeline. If a guard ever regressed to
 * reply.hijack() (the v0 bug), error responses would lose the header and
 * contract case 12 would fail.
 */

import { describe, expect, it } from 'bun:test'
import Fastify from 'fastify'
import type { FastifyRequest } from 'fastify'
import { kyroguardFastify } from '../../src/frameworks/fastify/index.js'
import type { FastifyDomain } from '../../src/frameworks/fastify/index.js'
import { runFrameworkContractSuite } from '../../src/testing/index.js'
import type { RouteSpec, TestApp, TestAppResponse } from '../../src/testing/index.js'
import type { Kyroguard, SubjectInput } from '../../src/index.js'

async function makeApp(rbac: Kyroguard, routes: RouteSpec[]): Promise<TestApp> {
  const app = Fastify()

  // Per-request getSubject invocation count (harness protocol item 1).
  const getSubjectCalls = new WeakMap<FastifyRequest, number>()

  // Harness protocol item 3: a framework-level hook that decorates EVERY
  // response — including 401/403/404 — through Fastify's native pipeline.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-app-hook', 'ran')
    reply.header('x-getsubject-calls', String(getSubjectCalls.get(req) ?? 0))
  })

  await app.register(kyroguardFastify(rbac))

  const domains = new Map<string, FastifyDomain>()
  const domainFor = (name: string): FastifyDomain => {
    let domain = domains.get(name)
    if (!domain) {
      domain = app.kyroguard.domain(name, {
        getSubject: req => {
          getSubjectCalls.set(req, (getSubjectCalls.get(req) ?? 0) + 1)
          const id = req.headers['x-subject-id']
          if (typeof id !== 'string' || id === '') return null
          const subject: SubjectInput = { id }
          const tenantId = req.headers['x-tenant-id']
          if (typeof tenantId === 'string' && tenantId !== '') subject.tenant_id = tenantId
          if (req.headers['x-super'] === '1') subject.is_super = true
          return subject
        },
      })
      domains.set(name, domain)
    }
    return domain
  }

  for (const route of routes) {
    const domain = domainFor(route.domain)
    const resource = route.resource
    const policies = route.policy ? route.policy.split('+') : []
    const guards = policies.map(policy =>
      domain.requirePolicy(policy, resource ? { resource: req => resource(req) } : undefined),
    )
    app.route({
      method: route.method,
      url: route.path,
      preHandler: guards,
      handler: async () => ({ ok: true }),
    })
  }

  await app.ready()

  return {
    request: async ({ method, path, headers }): Promise<TestAppResponse> => {
      const res = await app.inject({ method, url: path, headers })
      let body: unknown = null
      try {
        body = res.body === '' ? null : JSON.parse(res.body)
      } catch {
        body = res.body
      }
      const lower: Record<string, string> = {}
      for (const [key, value] of Object.entries(res.headers)) {
        if (value === undefined) continue
        lower[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
      }
      return { status: res.statusCode, body, headers: lower }
    },
    close: async () => {
      await app.close()
    },
  }
}

runFrameworkContractSuite({
  name: 'fastify (inject)',
  makeApp,
  test: { describe, it, expect },
})
