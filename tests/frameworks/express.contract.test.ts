/**
 * Express integration vs. the black-box framework contract suite.
 *
 * The TestApp here follows the harness protocol documented at the top of
 * src/testing/framework-suite.ts:
 *  - one domain per distinct route.domain, getSubject reads x-subject-id /
 *    x-tenant-id / x-super and counts its own invocations per request,
 *  - every response carries x-getsubject-calls with that request's total,
 *  - an app.use middleware registered BEFORE context() stamps
 *    `x-app-hook: ran` on EVERY response (including 401/403/404) — the
 *    hijack-bypass regression detector,
 *  - a real node:http server on port 0, requests via fetch, close() closes
 *    the server.
 */

import { describe, expect, it } from 'bun:test'
import express from 'express'
import { createServer } from 'node:http'
import { kyroguardExpress } from '../../src/frameworks/express/index.js'
import { runFrameworkContractSuite } from '../../src/testing/index.js'
import type { Request, RequestHandler, Response } from 'express'
import type { AddressInfo } from 'node:net'
import type { Kyroguard, SubjectInput } from '../../src/index.js'
import type { RouteSpec, TestApp } from '../../src/testing/index.js'

/** Per-request getSubject invocation counter, attached by the first middleware. */
interface CountedRequest extends Request {
  __getSubjectCalls?: { count: number }
}

function subjectFromHeaders(req: Request): SubjectInput | null {
  const id = req.header('x-subject-id')
  if (!id) return null
  const subject: SubjectInput = { id }
  const tenantId = req.header('x-tenant-id')
  if (tenantId) subject.tenant_id = tenantId
  if (req.header('x-super') === '1') subject.is_super = true
  return subject
}

async function makeApp(rbac: Kyroguard, routes: RouteSpec[]): Promise<TestApp> {
  const app = express()

  // Native Express middleware — MUST run for every response, including the
  // error pipeline and unmatched routes (404). Registered BEFORE context().
  app.use((req, res, next) => {
    res.setHeader('x-app-hook', 'ran')
    const counter = { count: 0 }
    ;(req as CountedRequest).__getSubjectCalls = counter
    // Stamp the final tally right before headers flush (on-headers pattern).
    const writeHead = res.writeHead.bind(res) as Response['writeHead']
    res.writeHead = ((...args: Parameters<Response['writeHead']>) => {
      res.setHeader('x-getsubject-calls', String(counter.count))
      return writeHead(...args)
    }) as Response['writeHead']
    next()
  })

  const integration = kyroguardExpress(rbac)
  app.use(integration.context())

  // The named-domain overload's return type (ReturnType picks the last overload).
  const domains = new Map<string, ReturnType<typeof integration.domain<string>>>()
  for (const route of routes) {
    if (domains.has(route.domain)) continue
    domains.set(
      route.domain,
      integration.domain(route.domain, {
        getSubject: req => {
          const counter = (req as CountedRequest).__getSubjectCalls
          if (counter) counter.count += 1
          return subjectFromHeaders(req)
        },
      }),
    )
  }

  for (const route of routes) {
    const domain = domains.get(route.domain)
    if (!domain) throw new Error(`missing domain ${route.domain}`)
    const guards: RequestHandler[] = (route.policy ? route.policy.split('+') : []).map(policy =>
      domain.requirePolicy(
        policy,
        route.resource ? { resource: req => route.resource!(req) } : undefined,
      ),
    )
    const handler: RequestHandler = (_req, res) => {
      res.status(200).json({ ok: true })
    }
    if (route.method === 'GET') app.get(route.path, ...guards, handler)
    else app.post(route.path, ...guards, handler)
  }

  app.use(integration.errorHandler())

  const server = createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}`

  return {
    async request({ method, path, headers }) {
      const res = await fetch(base + path, { method, headers })
      const text = await res.text()
      let body: unknown = null
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      const responseHeaders: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value
      })
      return { status: res.status, body, headers: responseHeaders }
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      ),
  }
}

runFrameworkContractSuite({
  name: 'express',
  makeApp,
  test: { describe, it, expect },
})

describe('express contract harness extras', () => {
  it('x-app-hook and x-getsubject-calls appear even on unmatched routes (404)', async () => {
    const { createKyroguard, Policy } = await import('../../src/index.js')
    const { memoryAdapter } = await import('../../src/testing/index.js')
    const rbac = createKyroguard({
      adapter: memoryAdapter(),
      resources: [{ type: 'thing', policies: [new Policy('thing.read')] }],
    })
    try {
      await rbac.sync([{ type: 'thing', policies: [new Policy('thing.read')] }], 'admin')
      const app = await makeApp(rbac, [
        {
          method: 'GET',
          path: '/thing',
          domain: 'admin',
          policy: 'thing.read',
          getSubjectFrom: 'header',
        },
      ])
      try {
        const res = await app.request({ method: 'GET', path: '/nope' })
        expect(res.status).toBe(404)
        expect(res.headers['x-app-hook']).toBe('ran')
        expect(res.headers['x-getsubject-calls']).toBe('0')
      } finally {
        await app.close()
      }
    } finally {
      rbac.dispose()
    }
  })
})
