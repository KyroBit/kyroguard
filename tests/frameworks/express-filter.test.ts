/**
 * domain.filterFor round-trip on Express against memoryAdapter listFilters:
 * the handler applies the returned trichotomy to seeded rows, so every kind
 * ('all' / 'none' / 'where' with a row predicate) is observed end to end.
 */

import { describe, expect, test } from 'bun:test'
import express from 'express'
import { createServer } from 'node:http'
import { rbacExpress } from '../../src/frameworks/express/index.js'
import { Policy, Scope, createRbac, qualifyPolicyName } from '../../src/index.js'
import type { AddressInfo } from 'node:net'
import type { Request } from 'express'
import type { FilterResult, Rbac, ResourceDefinition, SubjectInput } from '../../src/index.js'
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

async function seed(rbac: Rbac): Promise<void> {
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

interface Harness {
  get(path: string, subjectId?: string): Promise<{ status: number; body: any }>
}

async function withApp(fn: (h: Harness) => Promise<void>): Promise<void> {
  const rbac = createRbac({ adapter: memoryAdapter(), resources: makeResources() })
  try {
    await seed(rbac)
    const app = express()
    const integration = rbacExpress(rbac)
    app.use(integration.context())
    const staff = integration.domain('staff', {
      getSubject: (req: Request): SubjectInput | null => {
        const id = req.header('x-subject-id')
        return id ? { id } : null
      },
    })
    app.get('/sales', (req, res, next) => {
      staff.filterFor!(req, 'sales.view').then(filter => {
        res.json(render(filter))
      }, next)
    })
    app.get('/orphan', (req, res, next) => {
      staff.filterFor!(req, 'sales.missing').then(filter => {
        res.json(render(filter))
      }, next)
    })
    const renderActive = (): unknown => {
      const filter = rbac.engine.store.getActiveFilter('sale')
      return filter ? render(filter) : { kind: 'unset' }
    }
    app.get('/guarded-view', staff.requirePolicy('sales.view'), (_req, res) => {
      res.json(renderActive())
    })
    app.get(
      '/guarded-void',
      staff.requirePolicy('sales.void', { resource: () => ({ type: 'sale', id: 's1' }) }),
      (_req, res) => {
        res.json(renderActive())
      },
    )
    app.get('/hooked', staff.subjectHook(), (_req, res) => {
      res.json(renderActive())
    })
    app.use(integration.errorHandler())

    const server = createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      await fn({
        get: async (path, subjectId) => {
          const res = await fetch(`http://127.0.0.1:${port}${path}`, {
            headers: subjectId ? { 'x-subject-id': subjectId } : {},
          })
          return { status: res.status, body: await res.json() }
        },
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      )
    }
  } finally {
    rbac.dispose()
  }
}

describe('express domain.filterFor', () => {
  test("cashier ('owned' grant) → kind where; the predicate admits only the cashier's rows", () =>
    withApp(async h => {
      const res = await h.get('/sales', 'cashier')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ kind: 'where', ids: ['s1', 's2'] })
    }))

  test('manager (unscoped grant) → kind all', () =>
    withApp(async h => {
      const res = await h.get('/sales', 'manager')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ kind: 'all' })
    }))

  test('no grant → kind none, reason no-policy (an answer, not an error)', () =>
    withApp(async h => {
      const res = await h.get('/sales', 'stranger')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ kind: 'none', reason: 'no-policy' })
    }))

  test('false condition scope → kind none, reason scope-denied', () =>
    withApp(async h => {
      const res = await h.get('/sales', 'nightowl')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ kind: 'none', reason: 'scope-denied' })
    }))

  test('no subject → rejected UnauthenticatedError reaches errorHandler as 401', () =>
    withApp(async h => {
      const res = await h.get('/sales')
      expect(res.status).toBe(401)
      expect(res.body.code).toBe('RBAC_UNAUTHENTICATED')
    }))

  test('policy on no registered resource → 500 RBAC_MISCONFIGURED', () =>
    withApp(async h => {
      const res = await h.get('/orphan', 'cashier')
      expect(res.status).toBe(500)
      expect(res.body.code).toBe('RBAC_MISCONFIGURED')
    }))

  test("requirePolicy stores the exercised policy's plan — same subject, same table, per-route filters", () =>
    withApp(async h => {
      const view = await h.get('/guarded-view', 'supervisor')
      expect(view.status).toBe(200)
      expect(view.body).toEqual({ kind: 'all' })

      const voided = await h.get('/guarded-void', 'supervisor')
      expect(voided.status).toBe(200)
      expect(voided.body).toEqual({ kind: 'where', ids: ['s1'] })
    }))

  test('subjectHook stores NO filter — only guards activate one', () =>
    withApp(async h => {
      const res = await h.get('/hooked', 'supervisor')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ kind: 'unset' })
    }))
})
