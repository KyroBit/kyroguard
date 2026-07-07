/**
 * domain.filterFor round-trip on Fastify against memoryAdapter listFilters:
 * the handler applies the returned trichotomy to seeded rows, so every kind
 * ('all' / 'none' / 'where' with a row predicate) is observed end to end.
 * Also the guard side: requirePolicy stores the exercised policy's plan in
 * the request's activeFilters after allowing; subjectHook stores nothing.
 */

import { describe, expect, test } from 'bun:test'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { kyroguardFastify } from '../../src/frameworks/fastify/index.js'
import { Policy, Scope, createKyroguard, qualifyPolicyName } from '../../src/index.js'
import type { FilterResult, Kyroguard, ResourceDefinition, SubjectInput } from '../../src/index.js'
import { memoryAdapter } from '../../src/testing/index.js'
import type { MemoryWhere } from '../../src/testing/index.js'

const makeResources = (): ResourceDefinition[] => [
  {
    type: 'sale',
    policies: [
      new Policy('sales.view', undefined, [], [
        Scope.owned(),
        new Scope('closed-hours', 'Always closed', () => false),
      ]),
      new Policy('sales.void', undefined, [], [Scope.owned()]),
    ],
  },
]

const rows = [{ id: 's1' }, { id: 's2' }, { id: 's3' }]

async function seed(rbac: Kyroguard): Promise<void> {
  await rbac.sync(makeResources(), 'staff')
  const grant = (subjectId: string, scope: string, policy = 'sales.view'): Promise<void> =>
    rbac.admin.assignPolicy(
      { subjectId, domain: 'staff' },
      qualifyPolicyName('staff', policy),
      scope,
    )
  await grant('cashier', 'owned')
  await grant('manager', 'all')
  await grant('nightowl', 'closed-hours')
  await grant('supervisor', 'all')
  await grant('supervisor', 'owned', 'sales.void')
  await rbac.ownership.record('cashier', { type: 'sale', id: 's1' })
  await rbac.ownership.record('cashier', { type: 'sale', id: 's2' })
  await rbac.ownership.record('someone-else', { type: 'sale', id: 's3' })
  await rbac.ownership.record('supervisor', { type: 'sale', id: 's1' })
}

function render(filter: FilterResult): unknown {
  if (filter.kind === 'where') {
    return { kind: filter.kind, ids: rows.filter(filter.where as MemoryWhere).map(row => row.id) }
  }
  return filter
}

async function withApp(fn: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const rbac = createKyroguard({ adapter: memoryAdapter(), resources: makeResources() })
  try {
    await seed(rbac)
    const app = Fastify()
    await app.register(kyroguardFastify(rbac))
    const staff = app.kyroguard.domain('staff', {
      getSubject: (req): SubjectInput | null => {
        const id = req.headers['x-subject-id']
        return typeof id === 'string' && id !== '' ? { id } : null
      },
    })
    app.get('/sales', async req => render(await staff.filterFor!(req, 'sales.view')))
    const renderActive = (): unknown => {
      const filter = rbac.engine.store.getActiveFilter('sale')
      return filter ? render(filter) : { kind: 'unset' }
    }
    app.get('/guarded-view', { preHandler: staff.requirePolicy('sales.view') }, async () =>
      renderActive(),
    )
    app.get(
      '/guarded-void',
      {
        preHandler: staff.requirePolicy('sales.void', {
          resource: () => ({ type: 'sale', id: 's1' }),
        }),
      },
      async () => renderActive(),
    )
    app.get('/hooked', { preHandler: staff.subjectHook() }, async () => renderActive())
    await app.ready()
    try {
      await fn(app)
    } finally {
      await app.close()
    }
  } finally {
    rbac.dispose()
  }
}

const list = (app: FastifyInstance, subjectId?: string, url = '/sales') =>
  app.inject({
    method: 'GET',
    url,
    headers: subjectId ? { 'x-subject-id': subjectId } : {},
  })

describe('fastify domain.filterFor', () => {
  test("cashier ('owned' grant) → kind where; the predicate admits only the cashier's rows", () =>
    withApp(async app => {
      const res = await list(app, 'cashier')
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ kind: 'where', ids: ['s1', 's2'] })
    }))

  test('manager (unscoped grant) → kind all', () =>
    withApp(async app => {
      const res = await list(app, 'manager')
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ kind: 'all' })
    }))

  test('no grant → kind none, reason no-policy (an answer, not an error)', () =>
    withApp(async app => {
      const res = await list(app, 'stranger')
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ kind: 'none', reason: 'no-policy' })
    }))

  test('false condition scope → kind none, reason scope-denied', () =>
    withApp(async app => {
      const res = await list(app, 'nightowl')
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ kind: 'none', reason: 'scope-denied' })
    }))

  test('no subject → thrown UnauthenticatedError travels the pipeline as 401', () =>
    withApp(async app => {
      const res = await list(app)
      expect(res.statusCode).toBe(401)
      expect(JSON.parse(res.body).code).toBe('UNAUTHENTICATED')
    }))

  test('requirePolicy stores the exercised policy\'s plan — same subject, same table, per-route filters', () =>
    withApp(async app => {
      const view = await list(app, 'supervisor', '/guarded-view')
      expect(view.statusCode).toBe(200)
      expect(JSON.parse(view.body)).toEqual({ kind: 'all' })

      const voided = await list(app, 'supervisor', '/guarded-void')
      expect(voided.statusCode).toBe(200)
      expect(JSON.parse(voided.body)).toEqual({ kind: 'where', ids: ['s1'] })
    }))

  test('subjectHook stores NO filter — only guards activate one', () =>
    withApp(async app => {
      const res = await list(app, 'supervisor', '/hooked')
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ kind: 'unset' })
    }))

  test('policy on no registered resource → 500 MISCONFIGURED', async () => {
    const rbac = createKyroguard({ adapter: memoryAdapter(), resources: makeResources() })
    try {
      const app = Fastify()
      await app.register(kyroguardFastify(rbac))
      const staff = app.kyroguard.domain('staff', { getSubject: () => ({ id: 'u1' }) })
      app.get('/orphan', async req => render(await staff.filterFor!(req, 'sales.missing')))
      await app.ready()
      try {
        const res = await app.inject({ method: 'GET', url: '/orphan' })
        expect(res.statusCode).toBe(500)
        expect(JSON.parse(res.body).code).toBe('MISCONFIGURED')
      } finally {
        await app.close()
      }
    } finally {
      rbac.dispose()
    }
  })
})
