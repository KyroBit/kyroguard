/// <reference types="bun-types" />
/**
 * Prisma access relations (S21–S23) and ID-list filters (RFC §2.5) against
 * the real generated client on SQLite: relation-keyed upserts, relation-aware
 * isOwner, getAccess/removeAccess, and the owned/inTenant/granted fragments
 * including the 10k ceiling warning.
 */

import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import { PRISMA_ID_LIST_CAP, prismaAdapter } from '../../src/storage/prisma/index.js'
import type { OwnershipEntry } from '../../src/storage/contract.js'
import type { ResourceDefinition } from '../../src/core/policy.js'
import { makePrismaFixture } from './helpers/prisma-fixture/setup.js'

const fixture = await makePrismaFixture('rbac-prisma-filters-')
const { client } = fixture
const adapter = prismaAdapter(client)
const filters = adapter.listFilters!

const postResource = { type: 'post', policies: [] } as ResourceDefinition
const postRef = (id: string): { type: string; id: string } => ({ type: 'post', id })

const entry = (
  over: Partial<OwnershipEntry> & { resourceId: string; ownerId: string },
): OwnershipEntry => ({ resourceType: 'post', domain: '', tenantId: '', ...over })

const idsOf = (fragment: { where: unknown } | false): string[] => {
  expect(fragment).not.toBe(false)
  const where = (fragment as { where: { id: { in: string[] } } }).where
  return [...where.id.in].sort()
}

afterAll(async () => {
  await fixture.cleanup()
})

beforeEach(async () => {
  await client.rbacResourceOwner.deleteMany({})
  await client.post.deleteMany({})
})

describe('prisma access relations', () => {
  test('capabilities advertise listFiltering', () => {
    expect(adapter.capabilities.listFiltering).toBe(true)
  })

  test('recordOwnership defaults relation to owner and upserts per relation (S22)', async () => {
    await adapter.recordOwnership([entry({ resourceId: 'p1', ownerId: 'u1' })])
    await adapter.recordOwnership([entry({ resourceId: 'p1', ownerId: 'u1' })])
    await adapter.recordOwnership([
      entry({ resourceId: 'p1', ownerId: 'u1', relation: 'granted' }),
    ])
    await adapter.recordOwnership([
      entry({ resourceId: 'p1', ownerId: 'u1', relation: 'granted', domain: 'shop', tenantId: 't9' }),
    ])

    const rows: Array<{ relation: unknown; domain: unknown; tenantId: unknown }> =
      await client.rbacResourceOwner.findMany({
        where: { resourceType: 'post', resourceId: 'p1', ownerId: 'u1' },
        select: { relation: true, domain: true, tenantId: true },
      })
    expect(rows.map(row => String(row.relation)).sort()).toEqual(['granted', 'owner'])
    const granted = rows.find(row => row.relation === 'granted')!
    expect(String(granted.domain)).toBe('shop')
    expect(String(granted.tenantId)).toBe('t9')
  })

  test('isOwner matches only relation-owner rows (S22)', async () => {
    await adapter.recordOwnership([
      entry({ resourceId: 'p1', ownerId: 'u1', relation: 'granted' }),
    ])
    expect(await adapter.isOwner('u1', postRef('p1'))).toBe(false)

    await adapter.recordOwnership([entry({ resourceId: 'p1', ownerId: 'u1' })])
    expect(await adapter.isOwner('u1', postRef('p1'))).toBe(true)
  })

  test('getAccess returns every relation for the resource (S21)', async () => {
    await adapter.recordOwnership([
      entry({ resourceId: 'p1', ownerId: 'u1' }),
      entry({ resourceId: 'p1', ownerId: 'u2', relation: 'granted', tenantId: 't1' }),
      entry({ resourceId: 'p2', ownerId: 'u3' }),
    ])

    const access = await adapter.getAccess!(postRef('p1'))
    expect(
      access.map(row => ({ ownerId: row.ownerId, relation: row.relation, tenantId: row.tenantId })),
    ).toEqual([
      { ownerId: 'u1', relation: 'owner', tenantId: '' },
      { ownerId: 'u2', relation: 'granted', tenantId: 't1' },
    ])
  })

  test('removeAccess removes only matching entries (S23)', async () => {
    await adapter.recordOwnership([
      entry({ resourceId: 'p1', ownerId: 'u1' }),
      entry({ resourceId: 'p1', ownerId: 'u1', relation: 'granted' }),
      entry({ resourceId: 'p1', ownerId: 'u2', relation: 'granted' }),
      entry({ resourceId: 'p2', ownerId: 'u1', relation: 'granted' }),
    ])

    await adapter.removeAccess!('u1', postRef('p1'), 'granted')
    let access = await adapter.getAccess!(postRef('p1'))
    expect(access.map(row => `${row.ownerId}:${row.relation}`)).toEqual([
      'u1:owner',
      'u2:granted',
    ])

    await adapter.removeAccess!('u1', postRef('p1'))
    access = await adapter.getAccess!(postRef('p1'))
    expect(access.map(row => `${row.ownerId}:${row.relation}`)).toEqual(['u2:granted'])

    expect(await adapter.getAccess!(postRef('p2'))).toHaveLength(1)
  })

  test('removeOwnership removes all relations for the resource (S13)', async () => {
    await adapter.recordOwnership([
      entry({ resourceId: 'p1', ownerId: 'u1' }),
      entry({ resourceId: 'p1', ownerId: 'u2', relation: 'granted' }),
    ])
    await adapter.removeOwnership(postRef('p1'))
    expect(await adapter.getAccess!(postRef('p1'))).toEqual([])
  })
})

describe('prisma listFilters (honest ID-list)', () => {
  const seedPosts = async (...ids: string[]): Promise<void> => {
    for (const id of ids) await client.post.create({ data: { id, title: id } })
  }

  test('owned returns an id-list fragment of relation-owner rows only', async () => {
    await seedPosts('p1', 'p2', 'p3', 'p4')
    await adapter.recordOwnership([
      entry({ resourceId: 'p1', ownerId: 'u1' }),
      entry({ resourceId: 'p2', ownerId: 'u1' }),
      entry({ resourceId: 'p3', ownerId: 'u1', relation: 'granted' }),
      entry({ resourceId: 'p4', ownerId: 'u2' }),
    ])

    const fragment = await filters.owned('u1', postResource, client)
    expect(idsOf(fragment)).toEqual(['p1', 'p2'])

    const rows: Array<{ id: unknown }> = await client.post.findMany({
      where: (fragment as { where: unknown }).where,
      select: { id: true },
    })
    expect(rows.map(row => String(row.id)).sort()).toEqual(['p1', 'p2'])
  })

  test('granted returns only relation-granted rows for the subject', async () => {
    await adapter.recordOwnership([
      entry({ resourceId: 'p1', ownerId: 'u1' }),
      entry({ resourceId: 'p2', ownerId: 'u1', relation: 'granted' }),
      entry({ resourceId: 'p3', ownerId: 'u2', relation: 'granted' }),
    ])

    const fragment = await filters.granted('u1', postResource, client)
    expect(idsOf(fragment)).toEqual(['p2'])
  })

  test('inTenant matches tenant rows and fails closed on the empty sentinel', async () => {
    await adapter.recordOwnership([
      entry({ resourceId: 'p1', ownerId: 'u1', tenantId: 't1' }),
      entry({ resourceId: 'p2', ownerId: 'u2', relation: 'granted', tenantId: 't1' }),
      entry({ resourceId: 'p3', ownerId: 'u3' }),
    ])

    const fragment = await filters.inTenant('t1', postResource, client)
    expect(idsOf(fragment)).toEqual(['p1', 'p2'])

    expect(await filters.inTenant('', postResource, client)).toBe(false)
  })

  test('fragments target resource.prisma.idField when registered', async () => {
    await adapter.recordOwnership([entry({ resourceId: 'p1', ownerId: 'u1' })])
    const custom = {
      type: 'post',
      policies: [],
      prisma: { model: 'post', idField: 'postId' },
    } as ResourceDefinition

    const fragment = await filters.owned('u1', custom, client)
    const where = (fragment as { where: Record<string, { in: string[] }> }).where
    expect(where['postId']?.in).toEqual(['p1'])
    expect(where['id']).toBeUndefined()
  })

  test('or wraps fragments in OR; none matches no rows', async () => {
    const a = { id: { in: ['p1'] } }
    const b = { id: { in: ['p2'] } }
    expect(filters.or([a, b])).toEqual({ OR: [a, b] })

    await seedPosts('p1')
    const rows: unknown[] = await client.post.findMany({ where: filters.none() })
    expect(rows).toEqual([])
  })

  test('id-list caps at PRISMA_ID_LIST_CAP and warns once per adapter', async () => {
    const values: string[] = []
    for (let i = 0; i < PRISMA_ID_LIST_CAP + 50; i++) {
      values.push(`('cap-${i}', 'post', 'r${i}', 'u-cap')`)
    }
    for (let i = 0; i < values.length; i += 1000) {
      await client.$executeRawUnsafe(
        'INSERT INTO rbac_resource_owners (id, resource_type, resource_id, owner_id) VALUES ' +
          values.slice(i, i + 1000).join(','),
      )
    }

    const fresh = prismaAdapter(client)
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const first = await fresh.listFilters!.owned('u-cap', postResource, client)
      expect(idsOf(first)).toHaveLength(PRISMA_ID_LIST_CAP)
      await fresh.listFilters!.owned('u-cap', postResource, client)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('ceiling')
    } finally {
      warn.mockRestore()
    }
  })
})
