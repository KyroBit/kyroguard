/**
 * Express-integration specifics beyond the shared framework contract:
 * errorHandler semantics, formatError, next(err)-only guard failures (no
 * unhandled rejections), independent domains, ALS propagation under Bun,
 * and mounting under an express.Router.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import express, { Router } from 'express'
import { createServer } from 'node:http'
import { kyroguardExpress } from '../../src/frameworks/express/index.js'
import { PolicyDeniedError, ScopeDeniedError, UnauthenticatedError } from '../../src/core/errors.js'
import { Policy, createKyroguard } from '../../src/index.js'
import { memoryAdapter } from '../../src/testing/index.js'
import type { Express, Request, RequestHandler } from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Kyroguard, ResourceDefinition, SubjectInput } from '../../src/index.js'

// ── harness ──────────────────────────────────────────────────────────────────

const resources = (): ResourceDefinition[] => [
  { type: 'thing', policies: [new Policy('thing.read')] },
]

async function makeGuard(domains: string[] = ['admin']): Promise<Kyroguard> {
  const rbac = createKyroguard({ adapter: memoryAdapter(), resources: resources() })
  for (const domain of domains) await rbac.sync(resources(), domain)
  return rbac
}

interface Served {
  url: string
  close: () => Promise<void>
}

const servers: Server[] = []

async function serve(app: Express): Promise<Served> {
  const server = createServer(app)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      ),
  }
}

afterAll(() => {
  for (const server of servers) server.close()
})

const headerSubject = (req: Request): SubjectInput | null => {
  const id = req.header('x-subject-id')
  return id ? { id } : null
}

const okHandler: RequestHandler = (_req, res) => {
  res.json({ ok: true })
}

async function getJson(
  url: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { headers })
  const text = await res.text()
  let body: any = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

// ── unhandled-rejection sentinel (process-level, armed for the whole file) ───

const unhandledRejections: unknown[] = []
const sentinel = (reason: unknown): void => {
  unhandledRejections.push(reason)
}
process.on('unhandledRejection', sentinel)
afterAll(() => {
  process.off('unhandledRejection', sentinel)
})
beforeEach(() => {
  unhandledRejections.length = 0
})

// ── (a) errorHandler ─────────────────────────────────────────────────────────

describe('errorHandler()', () => {
  test('renders a KyroguardError as its statusCode + toBody() JSON — ACCESS_DENIED bodies carry reason', async () => {
    const rbac = await makeGuard()
    try {
      const app = express()
      const integration = kyroguardExpress(rbac)
      app.get('/denied', (_req, _res, next) => {
        next(new PolicyDeniedError('admin.thing.read'))
      })
      app.get('/scope-denied', (_req, _res, next) => {
        next(new ScopeDeniedError('admin.thing.read', 'owned'))
      })
      app.get('/unauth', (_req, _res, next) => {
        next(new UnauthenticatedError())
      })
      app.use(integration.errorHandler())
      const served = await serve(app)
      try {
        const denied = await getJson(`${served.url}/denied`)
        expect(denied.status).toBe(403)
        expect(denied.body).toEqual({ message: 'Forbidden', code: 'ACCESS_DENIED', reason: 'policy' })

        const scopeDenied = await getJson(`${served.url}/scope-denied`)
        expect(scopeDenied.status).toBe(403)
        expect(scopeDenied.body).toEqual({ message: 'Forbidden', code: 'ACCESS_DENIED', reason: 'scope' })

        const unauth = await getJson(`${served.url}/unauth`)
        expect(unauth.status).toBe(401)
        expect(unauth.body).toEqual({ message: 'Unauthorized', code: 'UNAUTHENTICATED' })
      } finally {
        await served.close()
      }
    } finally {
      rbac.dispose()
    }
  })

  test('delegates non-KyroguardError to the downstream error handler via next(err)', async () => {
    const rbac = await makeGuard()
    try {
      const app = express()
      const integration = kyroguardExpress(rbac)
      const boom = new Error('boom')
      let received: unknown = null
      app.get('/boom', (_req, _res, next) => {
        next(boom)
      })
      app.use(integration.errorHandler())
      app.use(((error: unknown, _req, res, _next) => {
        received = error
        res.status(502).json({ downstream: true })
      }) as express.ErrorRequestHandler)
      const served = await serve(app)
      try {
        const res = await getJson(`${served.url}/boom`)
        expect(res.status).toBe(502)
        expect(res.body).toEqual({ downstream: true })
        expect(received).toBe(boom)
      } finally {
        await served.close()
      }
    } finally {
      rbac.dispose()
    }
  })
})

// ── (b) formatError ──────────────────────────────────────────────────────────

describe('formatError option', () => {
  test('overrides both status and body, and receives the request', async () => {
    const rbac = await makeGuard()
    try {
      const app = express()
      const integration = kyroguardExpress(rbac, {
        formatError: (error, req) => ({
          status: 418,
          body: { kind: error.code, path: req.path, custom: true },
        }),
      })
      app.use(integration.context())
      const domain = integration.domain('admin', { getSubject: headerSubject })
      app.get('/thing', domain.requirePolicy('thing.read'), okHandler)
      app.use(integration.errorHandler())
      const served = await serve(app)
      try {
        const res = await getJson(`${served.url}/thing`, { 'x-subject-id': 'u1' })
        expect(res.status).toBe(418)
        expect(res.body).toEqual({ kind: 'ACCESS_DENIED', path: '/thing', custom: true })
      } finally {
        await served.close()
      }
    } finally {
      rbac.dispose()
    }
  })
})

// ── (c) guard failures always travel next(err) ───────────────────────────────

describe('guard error strategy', () => {
  test('a throwing getSubject yields a 500 through the default express handler, no unhandled rejection', async () => {
    const rbac = await makeGuard()
    try {
      const app = express()
      const integration = kyroguardExpress(rbac)
      app.use(integration.context())
      const domain = integration.domain('admin', {
        getSubject: () => {
          throw new Error('getSubject exploded')
        },
      })
      app.get('/thing', domain.requirePolicy('thing.read'), okHandler)
      // errorHandler forwards non-KyroguardError → express default terminal handler.
      app.use(integration.errorHandler())
      const served = await serve(app)
      try {
        const res = await fetch(`${served.url}/thing`, { headers: { 'x-subject-id': 'u1' } })
        expect(res.status).toBe(500)
        await res.text()
        // Let any stray rejection reach the process-level sentinel.
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(unhandledRejections).toEqual([])
      } finally {
        await served.close()
      }
    } finally {
      rbac.dispose()
    }
  })

  test('an async-rejecting getSubject also routes through next(err), never the socket', async () => {
    const rbac = await makeGuard()
    try {
      const app = express()
      const integration = kyroguardExpress(rbac)
      app.use((_req, res, next) => {
        res.setHeader('x-app-hook', 'ran')
        next()
      })
      app.use(integration.context())
      const domain = integration.domain('admin', {
        getSubject: async () => {
          await Promise.resolve()
          throw new Error('async explosion')
        },
      })
      app.get('/thing', domain.requirePolicy('thing.read'), okHandler)
      let sawDownstream = false
      app.use(integration.errorHandler())
      app.use(((error: unknown, _req, res, _next) => {
        sawDownstream = true
        res.status(500).json({ message: (error as Error).message })
      }) as express.ErrorRequestHandler)
      const served = await serve(app)
      try {
        const res = await fetch(`${served.url}/thing`, { headers: { 'x-subject-id': 'u1' } })
        expect(res.status).toBe(500)
        // The pipeline (earlier middleware headers) survived — no hijack.
        expect(res.headers.get('x-app-hook')).toBe('ran')
        expect(((await res.json()) as any).message).toBe('async explosion')
        expect(sawDownstream).toBe(true)
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(unhandledRejections).toEqual([])
      } finally {
        await served.close()
      }
    } finally {
      rbac.dispose()
    }
  })
})

// ── (d) two domains on one app ───────────────────────────────────────────────

describe('domain independence', () => {
  test('two domains resolve subjects and grants independently', async () => {
    const rbac = await makeGuard(['admin', 'branch'])
    try {
      const app = express()
      const integration = kyroguardExpress(rbac)
      app.use(integration.context())
      const admin = integration.domain('admin', { getSubject: headerSubject })
      const branch = integration.domain('branch', { getSubject: headerSubject })
      app.get('/admin/thing', admin.requirePolicy('thing.read'), okHandler)
      app.get('/branch/thing', branch.requirePolicy('thing.read'), okHandler)
      app.use(integration.errorHandler())

      // Domain sugar auto-qualifies: 'thing.read' → '<domain>.thing.read'.
      await admin.assignPolicy('u1', 'thing.read')
      await branch.assignPolicy('u2', 'thing.read')

      const served = await serve(app)
      try {
        expect((await getJson(`${served.url}/admin/thing`, { 'x-subject-id': 'u1' })).status).toBe(200)
        expect((await getJson(`${served.url}/branch/thing`, { 'x-subject-id': 'u2' })).status).toBe(200)
        // Registering the second domain must not clobber the first (clobbering regression).
        expect((await getJson(`${served.url}/admin/thing`, { 'x-subject-id': 'u1' })).status).toBe(200)

        const cross1 = await getJson(`${served.url}/branch/thing`, { 'x-subject-id': 'u1' })
        expect(cross1.status).toBe(403)
        expect(cross1.body.code).toBe('ACCESS_DENIED')
        const cross2 = await getJson(`${served.url}/admin/thing`, { 'x-subject-id': 'u2' })
        expect(cross2.status).toBe(403)
        expect(cross2.body.code).toBe('ACCESS_DENIED')
      } finally {
        await served.close()
      }
    } finally {
      rbac.dispose()
    }
  })
})

// ── (e) ALS propagation under Bun ────────────────────────────────────────────

describe('ALS propagation', () => {
  test('context() opens a store that survives into async handlers past guard resolution', async () => {
    const rbac = await makeGuard()
    try {
      await rbac.admin.assignPolicy(
        { subjectId: 'u1', domain: 'admin' },
        'admin.thing.read',
      )
      const app = express()
      const integration = kyroguardExpress(rbac)
      app.use(integration.context())
      const domain = integration.domain('admin', { getSubject: headerSubject })
      app.get('/thing', domain.requirePolicy('thing.read'), (async (_req, res) => {
        // Cross an await boundary before reading — the Bun regression case.
        await new Promise(resolve => setTimeout(resolve, 5))
        const store = rbac.engine.store.get()
        const subject = rbac.engine.store.getSubject()
        res.json({
          hasStore: store !== undefined,
          subjectId: subject?.id ?? null,
          subjectDomain: subject?.domain ?? null,
          memoized: store?.domainSubjects.get('admin')?.id ?? null,
        })
      }) as RequestHandler)
      app.use(integration.errorHandler())
      const served = await serve(app)
      try {
        const res = await getJson(`${served.url}/thing`, { 'x-subject-id': 'u1' })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({
          hasStore: true,
          subjectId: 'u1',
          subjectDomain: 'admin',
          memoized: 'u1',
        })
      } finally {
        await served.close()
      }
    } finally {
      rbac.dispose()
    }
  })

  test('concurrent requests keep isolated stores (no subject bleed)', async () => {
    const rbac = await makeGuard()
    try {
      const app = express()
      const integration = kyroguardExpress(rbac)
      app.use(integration.context())
      const domain = integration.domain('admin', { getSubject: headerSubject })
      app.get('/echo', domain.subjectHook(), (async (_req, res) => {
        await new Promise(resolve => setTimeout(resolve, 20))
        res.json({ id: rbac.engine.store.getSubject()?.id ?? null })
      }) as RequestHandler)
      app.use(integration.errorHandler())
      const served = await serve(app)
      try {
        const ids = ['a', 'b', 'c', 'd']
        const results = await Promise.all(
          ids.map(id => getJson(`${served.url}/echo`, { 'x-subject-id': id })),
        )
        expect(results.map(r => r.body.id)).toEqual(ids)
      } finally {
        await served.close()
      }
    } finally {
      rbac.dispose()
    }
  })

  test('guard without context() middleware fails as MISCONFIGURED via next(err), not a crash', async () => {
    const rbac = await makeGuard()
    try {
      const app = express()
      const integration = kyroguardExpress(rbac)
      // context() deliberately NOT registered.
      const domain = integration.domain('admin', { getSubject: headerSubject })
      app.get('/thing', domain.requirePolicy('thing.read'), okHandler)
      app.use(integration.errorHandler())
      const served = await serve(app)
      try {
        const res = await getJson(`${served.url}/thing`, { 'x-subject-id': 'u1' })
        expect(res.status).toBe(500)
        expect(res.body.code).toBe('MISCONFIGURED')
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(unhandledRejections).toEqual([])
      } finally {
        await served.close()
      }
    } finally {
      rbac.dispose()
    }
  })
})

// ── (f) mounted under a Router ───────────────────────────────────────────────

describe('router mounting', () => {
  test('guards work when routes live on a Router mounted at /api', async () => {
    const rbac = await makeGuard()
    try {
      await rbac.admin.assignPolicy({ subjectId: 'u1', domain: 'admin' }, 'admin.thing.read')
      const app = express()
      const integration = kyroguardExpress(rbac)
      app.use(integration.context())
      const domain = integration.domain('admin', { getSubject: headerSubject })

      const router = Router()
      router.get('/thing', domain.requirePolicy('thing.read'), okHandler)
      app.use('/api', router)
      app.use(integration.errorHandler())

      const served = await serve(app)
      try {
        const allowed = await getJson(`${served.url}/api/thing`, { 'x-subject-id': 'u1' })
        expect(allowed.status).toBe(200)
        expect(allowed.body).toEqual({ ok: true })

        const denied = await getJson(`${served.url}/api/thing`, { 'x-subject-id': 'u2' })
        expect(denied.status).toBe(403)
        expect(denied.body.code).toBe('ACCESS_DENIED')

        const unauth = await getJson(`${served.url}/api/thing`)
        expect(unauth.status).toBe(401)
        expect(unauth.body.code).toBe('UNAUTHENTICATED')
      } finally {
        await served.close()
      }
    } finally {
      rbac.dispose()
    }
  })

  test('router-scoped errorHandler renders errors inside the mount', async () => {
    const rbac = await makeGuard()
    try {
      const app = express()
      const integration = kyroguardExpress(rbac)
      app.use(integration.context())
      const domain = integration.domain('admin', { getSubject: headerSubject })

      const router = Router()
      router.get('/thing', domain.requirePolicy('thing.read'), okHandler)
      router.use(integration.errorHandler())
      app.use('/api', router)

      const served = await serve(app)
      try {
        const res = await getJson(`${served.url}/api/thing`)
        expect(res.status).toBe(401)
        expect(res.body.code).toBe('UNAUTHENTICATED')
      } finally {
        await served.close()
      }
    } finally {
      rbac.dispose()
    }
  })
})
