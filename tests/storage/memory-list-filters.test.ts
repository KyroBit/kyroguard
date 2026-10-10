/// <reference types="bun-types" />
/**
 * The memory adapter's fragment composition over plain row predicates — the
 * shape that makes engine.filterFor testable without a database — plus
 * filterFor driven end-to-end through createGuard against that adapter.
 */

import { describe, expect, test } from 'bun:test'

import { Policy, Scope, createGuard, toSubjectRef } from '../../src/index.js'
import type { FilterResult, Guard, StorageAdapter } from '../../src/index.js'
import { memoryAdapter } from '../../src/testing/index.js'
import type { MemoryWhere } from '../../src/testing/index.js'

/** The consumer's own data — the scopes below are written against it, not against kyroguard. */
const authorOf: Record<string, string> = { '1': 'u1', '2': 'u2', '3': 'u3' }
const tenantOf: Record<string, string> = { '1': '', '2': 't1', '3': '' }

const authored = new Scope('authored', 'Authored by the subject', subject => ({
  where: ((row: { id: string }) => authorOf[row.id] === subject.id) satisfies MemoryWhere,
}))

const sameTenant = new Scope('same-tenant', 'In the subject tenant', subject => {
  const tenantId = subject.tenant_id
  if (typeof tenantId !== 'string' || tenantId === '') return false
  return { where: ((row: { id: string }) => tenantOf[row.id] === tenantId) satisfies MemoryWhere }
})

const shared = new Scope('shared', 'Shared with the subject', subject => ({
  where: ((row: { id: string }) => row.id === '3' && subject.id === 'u1') satisfies MemoryWhere,
}))

const rows = [{ id: '1' }, { id: '2' }, { id: '3' }]

describe('memory adapter fragment composition', () => {
  test('or admits a row that any one fragment admits', () => {
    const adapter = memoryAdapter()
    const odd: MemoryWhere = row => row.id === '1'
    const even: MemoryWhere = row => row.id === '2'
    const either = adapter.listFilters!.or([odd, even]) as MemoryWhere
    expect(rows.filter(either).map(row => row.id)).toEqual(['1', '2'])
  })

  test('none admits nothing', () => {
    const adapter = memoryAdapter()
    const nothing = adapter.listFilters!.none() as MemoryWhere
    expect(rows.filter(nothing)).toEqual([])
  })
})

describe('filterFor end-to-end through createGuard', () => {
  const buildGuard = async (): Promise<{ adapter: StorageAdapter; rbac: Guard }> => {
    const adapter = memoryAdapter()
    const rbac = createGuard({
      adapter,
      cache: false,
      resources: [
        {
          type: 'post',
          policies: [
            new Policy('posts.view', { scopeOptions: [authored, shared, sameTenant] }),
          ],
        },
      ],
    })
    await rbac.sync()
    return { adapter, rbac }
  }

  const listWith = async (filter: FilterResult): Promise<{ id: string }[]> => {
    if (filter.kind === 'none') return []
    if (filter.kind === 'all') return rows
    return rows.filter(filter.where as MemoryWhere)
  }

  test('a single scoped grant narrows the list to the rows its fragment admits', async () => {
    const { rbac } = await buildGuard()
    await rbac.engine.assignPolicy(toSubjectRef({ id: 'u1' }), 'posts.view', 'authored')

    const filter = await rbac.engine.filterFor({ id: 'u1' }, 'posts.view', rbac.resources[0]!)
    expect(filter.kind).toBe('where')
    expect(await listWith(filter)).toEqual([{ id: '1' }])
  })

  test('two scopes on one policy — one direct, one via a group — union their rows', async () => {
    const { adapter, rbac } = await buildGuard()
    await rbac.engine.assignPolicy(toSubjectRef({ id: 'u1' }), 'posts.view', 'authored')
    await adapter.upsertGroup({ name: 'viewers', label: 'Viewers' })
    await adapter.setGroupPolicies('viewers', [{ policyName: 'posts.view', scope: 'shared' }])
    await adapter.assignGroup({ subjectId: 'u1', domain: '', tenantId: '' }, 'viewers')

    const filter = await rbac.engine.filterFor({ id: 'u1' }, 'posts.view', rbac.resources[0]!)
    expect(await listWith(filter)).toEqual([{ id: '1' }, { id: '3' }])
  })

  test('a scope reading the subject tenant admits only that tenant rows', async () => {
    const { rbac } = await buildGuard()
    await rbac.engine.assignPolicy(toSubjectRef({ id: 'u9', tenant_id: 't1' }), 'posts.view', 'same-tenant')

    const filter = await rbac.engine.filterFor(
      { id: 'u9', tenant_id: 't1' },
      'posts.view',
      rbac.resources[0]!,
    )
    expect(await listWith(filter)).toEqual([{ id: '2' }])
  })

  test('a scope that returns false for this subject empties the list', async () => {
    const { rbac } = await buildGuard()
    await rbac.engine.assignPolicy(toSubjectRef({ id: 'u8' }), 'posts.view', 'same-tenant')

    const filter = await rbac.engine.filterFor({ id: 'u8' }, 'posts.view', rbac.resources[0]!)
    expect(filter).toEqual({ kind: 'none', reason: 'scope-denied' })
    expect(await listWith(filter)).toEqual([])
  })

  test('no grant at all empties the list rather than opening it', async () => {
    const { rbac } = await buildGuard()

    const filter = await rbac.engine.filterFor({ id: 'stranger' }, 'posts.view', rbac.resources[0]!)
    expect(filter).toEqual({ kind: 'none', reason: 'no-policy' })
    expect(await listWith(filter)).toEqual([])
  })

  test('an unscoped grant leaves the query untouched', async () => {
    const { rbac } = await buildGuard()
    await rbac.engine.assignPolicy(toSubjectRef({ id: 'u1' }), 'posts.view')

    const filter = await rbac.engine.filterFor({ id: 'u1' }, 'posts.view', rbac.resources[0]!)
    expect(filter).toEqual({ kind: 'all' })
    expect(await listWith(filter)).toEqual(rows)
  })
})
