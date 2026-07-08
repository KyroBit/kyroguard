/// <reference types="bun-types" />
/**
 * The memory adapter's listFilters over plain row predicates — the shape that
 * makes engine.filterFor testable without a database — plus assertScopeParity
 * driven end-to-end through createGuard against the reference adapter.
 */

import { describe, expect, test } from 'bun:test'

import { Policy, Scope, createGuard } from '../../src/index.js'
import type { FilterResult, Guard, StorageAdapter } from '../../src/index.js'
import { assertScopeParity, memoryAdapter } from '../../src/testing/index.js'
import type { MemoryWhere } from '../../src/testing/index.js'

const post = { type: 'post', policies: [] }

const seedAccess = (adapter: StorageAdapter): Promise<void> =>
  adapter.recordOwnership([
    { resourceType: 'post', resourceId: '1', ownerId: 'u1', domain: '', tenantId: '' },
    { resourceType: 'post', resourceId: '2', ownerId: 'u2', domain: '', tenantId: 't1' },
    {
      resourceType: 'post',
      resourceId: '3',
      ownerId: 'u1',
      relation: 'granted',
      domain: '',
      tenantId: '',
    },
    { resourceType: 'comment', resourceId: '1', ownerId: 'u1', domain: '', tenantId: '' },
  ])

const matching = (fragment: { where: unknown } | false, ids: string[]): string[] => {
  if (fragment === false) throw new Error('expected a fragment, got false')
  return ids.filter(id => (fragment.where as MemoryWhere)({ id }))
}

describe('memory adapter listFilters — predicate fragments', () => {
  test("owned matches only the subject's relation-'owner' rows of the listed type", async () => {
    const adapter = memoryAdapter()
    await seedAccess(adapter)
    const fragment = await adapter.listFilters!.owned('u1', post, undefined)
    expect(matching(fragment, ['1', '2', '3'])).toEqual(['1'])
  })

  test("granted matches only the subject's relation-'granted' rows", async () => {
    const adapter = memoryAdapter()
    await seedAccess(adapter)
    const fragment = await adapter.listFilters!.granted('u1', post, undefined)
    expect(matching(fragment, ['1', '2', '3'])).toEqual(['3'])
  })

  test('inTenant matches rows with any access entry in the tenant, regardless of relation', async () => {
    const adapter = memoryAdapter()
    await seedAccess(adapter)
    const fragment = await adapter.listFilters!.inTenant('t1', post, undefined)
    expect(matching(fragment, ['1', '2', '3'])).toEqual(['2'])
  })

  test("inTenant fails closed on the '' no-tenant sentinel — it never matches stored '' rows", async () => {
    const adapter = memoryAdapter()
    await seedAccess(adapter)
    expect(await adapter.listFilters!.inTenant('', post, undefined)).toBe(false)
  })

  test('fragments evaluate lazily against the live store — rows seeded after compilation are visible', async () => {
    const adapter = memoryAdapter()
    const fragment = await adapter.listFilters!.owned('u1', post, undefined)
    expect(matching(fragment, ['9'])).toEqual([])
    await adapter.recordOwnership([
      { resourceType: 'post', resourceId: '9', ownerId: 'u1', domain: '', tenantId: '' },
    ])
    expect(matching(fragment, ['9'])).toEqual(['9'])
  })

  test('or folds predicates; none is the always-false predicate', async () => {
    const adapter = memoryAdapter()
    await seedAccess(adapter)
    const owned = await adapter.listFilters!.owned('u1', post, undefined)
    const granted = await adapter.listFilters!.granted('u1', post, undefined)
    const either = adapter.listFilters!.or([
      (owned as { where: unknown }).where,
      (granted as { where: unknown }).where,
    ]) as MemoryWhere
    expect(['1', '2', '3'].filter(id => either({ id }))).toEqual(['1', '3'])
    const none = adapter.listFilters!.none() as MemoryWhere
    expect(['1', '2', '3'].filter(id => none({ id }))).toEqual([])
  })
})

describe('assertScopeParity — filterFor end-to-end on the memory adapter', () => {
  const buildGuard = async (): Promise<{ adapter: StorageAdapter; rbac: Guard }> => {
    const adapter = memoryAdapter()
    const rbac = createGuard({
      adapter,
      cache: false,
      resources: [
        {
          type: 'post',
          policies: [
            new Policy('posts.view', {
              scopeOptions: [Scope.owned(), Scope.granted(), Scope.inTenant()],
            }),
          ],
        },
      ],
    })
    await rbac.sync()
    await seedAccess(adapter)
    return { adapter, rbac }
  }

  const rows = [{ id: '1' }, { id: '2' }, { id: '3' }]

  const runQuery = (allRows: { id: string }[]) => async (filter: FilterResult) => {
    if (filter.kind === 'none') return []
    if (filter.kind === 'all') return allRows
    return allRows.filter(filter.where as MemoryWhere)
  }

  test("a single 'owned' grant filters the list to owned rows and holds parity", async () => {
    const { rbac } = await buildGuard()
    await rbac.admin.assignPolicy({ subjectId: 'u1' }, 'posts.view', 'owned')
    const subject = { id: 'u1' }

    const filter = await rbac.engine.filterFor(subject, 'posts.view', rbac.resources[0]!)
    expect(filter.kind).toBe('where')
    expect(await runQuery(rows)(filter)).toEqual([{ id: '1' }])

    await assertScopeParity({
      guard: rbac,
      subject,
      policy: 'posts.view',
      resource: 'post',
      rows,
      query: runQuery(rows),
    })
  })

  test('multiple scopes on one policy OR together on both paths', async () => {
    const { adapter, rbac } = await buildGuard()
    await rbac.admin.assignPolicy({ subjectId: 'u1' }, 'posts.view', 'owned')
    await adapter.upsertGroup({ name: 'viewers', label: 'Viewers' })
    await adapter.setGroupPolicies('viewers', [{ policyName: 'posts.view', scope: 'granted' }])
    await adapter.assignGroup({ subjectId: 'u1', domain: '', tenantId: '' }, 'viewers')
    const subject = { id: 'u1' }

    const filter = await rbac.engine.filterFor(subject, 'posts.view', rbac.resources[0]!)
    expect(await runQuery(rows)(filter)).toEqual([{ id: '1' }, { id: '3' }])

    await assertScopeParity({
      guard: rbac,
      subject,
      policy: 'posts.view',
      resource: 'post',
      rows,
      query: runQuery(rows),
    })
  })

  test("the 'in-tenant' scope passes only rows with an access entry in the subject's tenant", async () => {
    const { rbac } = await buildGuard()
    await rbac.admin.assignPolicy(
      { subjectId: 'u9', tenantId: 't1' },
      'posts.view',
      'in-tenant',
    )
    const subject = { id: 'u9', tenant_id: 't1' }

    const filter = await rbac.engine.filterFor(subject, 'posts.view', rbac.resources[0]!)
    expect(await runQuery(rows)(filter)).toEqual([{ id: '2' }])

    await assertScopeParity({
      guard: rbac,
      subject,
      policy: 'posts.view',
      resource: 'post',
      rows,
      query: runQuery(rows),
    })
  })

  test("an 'in-tenant' grant held by a tenant-less subject folds to none on both paths", async () => {
    const { rbac } = await buildGuard()
    await rbac.admin.assignPolicy({ subjectId: 'u8' }, 'posts.view', 'in-tenant')
    const subject = { id: 'u8' }

    const filter = await rbac.engine.filterFor(subject, 'posts.view', rbac.resources[0]!)
    expect(filter).toEqual({ kind: 'none', reason: 'scope-denied' })

    await assertScopeParity({
      guard: rbac,
      subject,
      policy: 'posts.view',
      resource: 'post',
      rows,
      query: runQuery(rows),
    })
  })

  test('no grant at all is parity-safe: filterFor answers no-policy, authorize denies, the list is empty', async () => {
    const { rbac } = await buildGuard()
    const subject = { id: 'stranger' }

    const filter = await rbac.engine.filterFor(subject, 'posts.view', rbac.resources[0]!)
    expect(filter).toEqual({ kind: 'none', reason: 'no-policy' })

    await assertScopeParity({
      guard: rbac,
      subject,
      policy: 'posts.view',
      resource: 'post',
      rows,
      query: runQuery(rows),
    })
  })

  test('assertScopeParity rejects when the query drifts from the checks', async () => {
    const { rbac } = await buildGuard()
    await rbac.admin.assignPolicy({ subjectId: 'u1' }, 'posts.view', 'owned')

    expect(
      assertScopeParity({
        guard: rbac,
        subject: { id: 'u1' },
        policy: 'posts.view',
        resource: 'post',
        rows,
        query: async () => rows, // ignores the filter — leaks rows 2 and 3
      }),
    ).rejects.toThrow(/parity violated/i)
  })

  test('assertScopeParity rejects loudly for an unregistered resource type', async () => {
    const { rbac } = await buildGuard()
    expect(
      assertScopeParity({
        guard: rbac,
        subject: { id: 'u1' },
        policy: 'posts.view',
        resource: 'ghost',
        rows,
        query: runQuery(rows),
      }),
    ).rejects.toThrow(/not registered/)
  })
})
