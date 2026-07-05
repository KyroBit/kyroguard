/**
 * Fastify-specific behavior beyond the shared framework contract:
 * error-body shape, user error handlers, formatError, encapsulated
 * subjectHook scopes, per-domain subject memoization and ALS propagation
 * under Bun.
 */

import { describe, expect, test } from 'bun:test'
import Fastify from 'fastify'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { rbacFastify } from '../../src/frameworks/fastify/index.js'
import type { RbacFastifyOptions } from '../../src/frameworks/fastify/index.js'
import {
  Policy,
  PolicyDeniedError,
  createRbac,
  qualifyPolicyName,
} from '../../src/index.js'
import type { DecisionEvent, Rbac, ResourceDefinition, SubjectInput } from '../../src/index.js'
import { memoryAdapter } from '../../src/testing/index.js'

const makeResources = (): ResourceDefinition[] => [
  { type: 'thing', policies: [new Policy('thing.read'), new Policy('other.read')] },
]

interface Harness {
  rbac: Rbac
  app: FastifyInstance
}

async function withHarness(
  config: {
    domains?: string[]
    onDecision?: (event: DecisionEvent) => void
    pluginOptions?: RbacFastifyOptions
    setup: (app: FastifyInstance, rbac: Rbac) => Promise<void> | void
  },
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const rbac = createRbac({
    adapter: memoryAdapter(),
    resources: makeResources(),
    onDecision: config.onDecision,
  })
  try {
    for (const domain of config.domains ?? ['admin']) {
      await rbac.sync(makeResources(), domain)
    }
    const app = Fastify()
    await app.register(rbacFastify(rbac, config.pluginOptions))
    await config.setup(app, rbac)
    await app.ready()
    try {
      await fn({ rbac, app })
    } finally {
      await app.close()
    }
  } finally {
    rbac.dispose()
  }
}

/** Standard header-driven getSubject used where the test needs a real subject. */
const headerSubject = (req: FastifyRequest): SubjectInput | null => {
  const id = req.headers['x-subject-id']
  if (typeof id !== 'string' || id === '') return null
  return { id }
}

const parse = (body: string): any => JSON.parse(body)

describe('fastify integration specifics', () => {
  test('(a) default 403 body carries statusCode and code RBAC_POLICY_DENIED through the default serializer', () =>
    withHarness(
      {
        setup: app => {
          const domain = app.rbac.domain('admin', { getSubject: headerSubject })
          app.get('/thing', { preHandler: domain.requirePolicy('thing.read') }, async () => ({
            ok: true,
          }))
        },
      },
      async ({ app }) => {
        const res = await app.inject({
          method: 'GET',
          url: '/thing',
          headers: { 'x-subject-id': 'u1' },
        })
        expect(res.statusCode).toBe(403)
        const body = parse(res.body)
        expect(body.statusCode).toBe(403)
        expect(body.code).toBe('RBAC_POLICY_DENIED')
        expect(typeof body.message).toBe('string')
      },
    ))

  test('(b) a user setErrorHandler receives the thrown PolicyDeniedError (instanceof works) and shapes the body', () =>
    withHarness(
      {
        setup: app => {
          const domain = app.rbac.domain('admin', { getSubject: headerSubject })
          let seen: unknown = null
          app.setErrorHandler((error, _req, reply) => {
            seen = error
            return reply.code(418).send({
              shaped: true,
              isRbacPolicyDenied: error instanceof PolicyDeniedError,
              policy: error instanceof PolicyDeniedError ? error.policy : null,
            })
          })
          app.get('/thing', { preHandler: domain.requirePolicy('thing.read') }, async () => ({
            ok: true,
          }))
          app.get('/seen', async () => ({ seenIsError: seen instanceof PolicyDeniedError }))
        },
      },
      async ({ app }) => {
        const res = await app.inject({
          method: 'GET',
          url: '/thing',
          headers: { 'x-subject-id': 'u1' },
        })
        expect(res.statusCode).toBe(418)
        const body = parse(res.body)
        expect(body.shaped).toBe(true)
        expect(body.isRbacPolicyDenied).toBe(true)
        expect(body.policy).toBe(qualifyPolicyName('admin', 'thing.read'))

        const seen = await app.inject({ method: 'GET', url: '/seen' })
        expect(parse(seen.body).seenIsError).toBe(true)
      },
    ))

  test('(c) formatError produces the custom status/body and onSend hooks still run', () =>
    withHarness(
      {
        pluginOptions: {
          formatError: (error, req) => ({
            status: 422,
            body: { kind: 'custom', code: error.code, url: req.url },
          }),
        },
        setup: app => {
          app.addHook('onSend', async (_req, reply) => {
            reply.header('x-app-hook', 'ran')
          })
          const domain = app.rbac.domain('admin', { getSubject: headerSubject })
          app.get('/thing', { preHandler: domain.requirePolicy('thing.read') }, async () => ({
            ok: true,
          }))
        },
      },
      async ({ app }) => {
        const res = await app.inject({
          method: 'GET',
          url: '/thing',
          headers: { 'x-subject-id': 'u1' },
        })
        expect(res.statusCode).toBe(422)
        const body = parse(res.body)
        expect(body.kind).toBe('custom')
        expect(body.code).toBe('RBAC_POLICY_DENIED')
        expect(body.url).toBe('/thing')
        // No hijacked reply: the formatted error still travels onSend.
        expect(res.headers['x-app-hook']).toBe('ran')
      },
    ))

  test('(d) subjectHook in an encapsulated scope sets the subject for that scope only', () =>
    withHarness(
      {
        setup: async (app, rbac) => {
          const domain = app.rbac.domain('admin', { getSubject: headerSubject })
          const subjectIdInStore = () => rbac.engine.store.getSubject()?.id ?? null

          await app.register(async scope => {
            scope.addHook('preHandler', domain.subjectHook())
            scope.get('/scoped', async () => ({ subjectId: subjectIdInStore() }))
          })
          await app.register(async scope => {
            scope.get('/sibling', async () => ({ subjectId: subjectIdInStore() }))
          })
        },
      },
      async ({ app }) => {
        const scoped = await app.inject({
          method: 'GET',
          url: '/scoped',
          headers: { 'x-subject-id': 'u1' },
        })
        expect(scoped.statusCode).toBe(200)
        expect(parse(scoped.body).subjectId).toBe('u1')

        // The sibling scope never registered the hook — no subject leaks in.
        const sibling = await app.inject({
          method: 'GET',
          url: '/sibling',
          headers: { 'x-subject-id': 'u1' },
        })
        expect(sibling.statusCode).toBe(200)
        expect(parse(sibling.body).subjectId).toBe(null)
      },
    ))

  test('(e) two domains registered, two stacked guards from ONE domain → its getSubject runs exactly once', async () => {
    let callsA = 0
    let callsB = 0
    await withHarness(
      {
        domains: ['a', 'b'],
        setup: async (app, rbac) => {
          const domainA = app.rbac.domain('a', {
            getSubject: req => {
              callsA += 1
              return headerSubject(req)
            },
          })
          // Domain B exists on the same app but guards nothing on this route.
          app.rbac.domain('b', {
            getSubject: req => {
              callsB += 1
              return headerSubject(req)
            },
          })
          app.get(
            '/multi',
            {
              preHandler: [domainA.requirePolicy('thing.read'), domainA.requirePolicy('other.read')],
            },
            async () => ({ ok: true }),
          )
          await rbac.admin.assignPolicy(
            { subjectId: 'u1', domain: 'a' },
            qualifyPolicyName('a', 'thing.read'),
          )
          await rbac.admin.assignPolicy(
            { subjectId: 'u1', domain: 'a' },
            qualifyPolicyName('a', 'other.read'),
          )
        },
      },
      async ({ app }) => {
        const res = await app.inject({
          method: 'GET',
          url: '/multi',
          headers: { 'x-subject-id': 'u1' },
        })
        expect(res.statusCode).toBe(200)
        expect(callsA).toBe(1)
        expect(callsB).toBe(0)
      },
    )
  })

  test('(f) per-domain memoization is independent: guards from two domains on one route each authorize their own subject', async () => {
    const events: DecisionEvent[] = []
    await withHarness(
      {
        domains: ['a', 'b'],
        onDecision: event => events.push(event),
        setup: async (app, rbac) => {
          // Distinct subjects per domain — if domain B's guard ever read domain
          // A's memoized subject, its decision would carry subjectId 'ua'.
          const domainA = app.rbac.domain('a', { getSubject: () => ({ id: 'ua' }) })
          const domainB = app.rbac.domain('b', { getSubject: () => ({ id: 'ub' }) })
          app.get(
            '/both',
            { preHandler: [domainA.requirePolicy('thing.read'), domainB.requirePolicy('thing.read')] },
            async () => ({ ok: true }),
          )
          await rbac.admin.assignPolicy(
            { subjectId: 'ua', domain: 'a' },
            qualifyPolicyName('a', 'thing.read'),
          )
          await rbac.admin.assignPolicy(
            { subjectId: 'ub', domain: 'b' },
            qualifyPolicyName('b', 'thing.read'),
          )
        },
      },
      async ({ app }) => {
        const res = await app.inject({ method: 'GET', url: '/both' })
        expect(res.statusCode).toBe(200)

        expect(events).toHaveLength(2)
        const [first, second] = events
        expect(first!.decision).toBe('allow')
        expect(first!.subjectId).toBe('ua')
        expect(first!.domain).toBe('a')
        expect(first!.policy).toBe(qualifyPolicyName('a', 'thing.read'))

        expect(second!.decision).toBe('allow')
        expect(second!.subjectId).toBe('ub')
        expect(second!.domain).toBe('b')
        expect(second!.policy).toBe(qualifyPolicyName('b', 'thing.read'))
      },
    )
  })

  test('(g) ALS context propagates from the onRequest hook to the route handler under Bun', () =>
    withHarness(
      {
        setup: (app, rbac) => {
          app.get('/als', async () => {
            const store = rbac.engine.store.get()
            return {
              hasStore: store !== undefined,
              domainSubjectsIsMap: store?.domainSubjects instanceof Map,
              subject: store?.subject ?? null,
            }
          })
        },
      },
      async ({ app }) => {
        const res = await app.inject({ method: 'GET', url: '/als' })
        expect(res.statusCode).toBe(200)
        const body = parse(res.body)
        expect(body.hasStore).toBe(true)
        expect(body.domainSubjectsIsMap).toBe(true)
        expect(body.subject).toBe(null)

        // Fresh store per request — nothing carried over from the first one.
        const again = await app.inject({ method: 'GET', url: '/als' })
        expect(parse(again.body).hasStore).toBe(true)
      },
    ))
})
