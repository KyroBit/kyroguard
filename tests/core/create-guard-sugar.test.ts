/**
 * DX sugar around createGuard — the shapes the quick start is built on:
 * plain `policies`, `groups` seeded by sync(), no-arg sync, and the
 * nameless domain({ getSubject }) overload.
 */
import { describe, test, expect } from 'bun:test'
import Fastify from 'fastify'
import { createGuard, Policy } from '../../src/index.js'
import { kyroguardFastify } from '../../src/frameworks/fastify/index.js'
import { memoryAdapter } from '../../src/testing/index.js'

const definitions = () => ({
  policies: [
    new Policy('sales.view'),
    new Policy('sales.create', 'Create sale', ['sales.view']),
  ],
  groups: {
    cashier: { label: 'Cashier', policies: ['sales.create'] },
  },
})

describe('createGuard sugar', () => {
  test('sync() with no arguments syncs the policies given to createGuard', async () => {
    const adapter = memoryAdapter()
    const rbac = createGuard({ adapter, policies: definitions().policies })

    await rbac.sync()

    const names = (await adapter.listPolicies()).map(policy => policy.name).toSorted()
    expect(names).toEqual(['sales.create', 'sales.view'])
    rbac.dispose()
  })

  test('sync() also seeds the groups given to createGuard, with dependency back-fill', async () => {
    const adapter = memoryAdapter()
    const { policies, groups } = definitions()
    const rbac = createGuard({ adapter, policies, groups })

    await rbac.sync()

    // cashier was defined with only sales.create; sales.view arrives via back-fill.
    const entries = await adapter.getGroupPolicies('cashier')
    expect(entries.map(entry => entry.policyName).toSorted()).toEqual([
      'sales.create',
      'sales.view',
    ])
    rbac.dispose()
  })

  test('sync(domain) qualifies both policies and groups under the domain', async () => {
    const adapter = memoryAdapter()
    const { policies, groups } = definitions()
    const rbac = createGuard({ adapter, policies, groups })

    await rbac.sync('branch')

    const names = (await adapter.listPolicies()).map(policy => policy.name).toSorted()
    expect(names).toEqual(['branch.sales.create', 'branch.sales.view'])
    const entries = await adapter.getGroupPolicies('cashier')
    expect(entries.map(entry => entry.policyName).toSorted()).toEqual([
      'branch.sales.create',
      'branch.sales.view',
    ])
    rbac.dispose()
  })

  test("seedGroups resolves 'all' from createGuard's policies automatically", async () => {
    const adapter = memoryAdapter()
    const { policies } = definitions()
    const rbac = createGuard({ adapter, policies })
    await rbac.sync()

    await rbac.seedGroups({ owner: { label: 'Owner', policies: 'all' } })

    const entries = await adapter.getGroupPolicies('owner')
    expect(entries.map(entry => entry.policyName).toSorted()).toEqual([
      'sales.create',
      'sales.view',
    ])
    rbac.dispose()
  })

  test('explicit sync(resources, domain) does not touch groups', async () => {
    const adapter = memoryAdapter()
    const { policies, groups } = definitions()
    const rbac = createGuard({ adapter, policies, groups })

    await rbac.sync([{ type: 'sale', policies }], 'other')

    expect(await adapter.listGroups()).toEqual([])
    rbac.dispose()
  })

  test('domain({ getSubject }) guards with unqualified policy names end to end', async () => {
    const adapter = memoryAdapter()
    const { policies, groups } = definitions()
    const rbac = createGuard({ adapter, policies, groups })
    await rbac.sync()

    const app = Fastify()
    await app.register(kyroguardFastify(rbac))
    const shop = app.kyroguard.domain({
      getSubject: async req => {
        const id = req.headers['x-user-id']
        return typeof id === 'string' ? { id } : null
      },
    })
    app.get('/sales', { preHandler: shop.requirePolicy('sales.view') }, async () => [])

    const denied = await app.inject({ url: '/sales', headers: { 'x-user-id': 'u1' } })
    expect(denied.statusCode).toBe(403)

    await shop.assignGroup('u1', 'cashier')
    const allowed = await app.inject({ url: '/sales', headers: { 'x-user-id': 'u1' } })
    expect(allowed.statusCode).toBe(200)

    await app.close()
    rbac.dispose()
  })
})
