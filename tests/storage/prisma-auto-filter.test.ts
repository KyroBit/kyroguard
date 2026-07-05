/// <reference types="bun-types" />
/**
 * Automatic read filtering through rbacPrismaExtension against the real
 * generated client on SQLite: findMany/findFirst/findUnique/count are
 * intercepted for models whose resource definition carries `list`. A scoped
 * grant ANDs the rbac fragment into the caller's where, an unscoped grant
 * passes through untouched, no grant short-circuits to []/null/0 without
 * touching the resource table, and the subject/isInAuthz guards keep
 * engine-internal and subject-less queries unfiltered.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { Policy, Scope, createRbac } from '../../src/index.js'
import { prismaAdapter, rbacPrismaExtension } from '../../src/storage/prisma/index.js'
import { makePrismaFixture } from './helpers/prisma-fixture/setup.js'
import type { Subject } from '../../src/core/types.js'

const fixture = await makePrismaFixture('rbac-prisma-autofilter-')
const { client } = fixture
const adapter = prismaAdapter(client)

const rbac = createRbac({
  adapter,
  cache: false,
  resources: [
    {
      type: 'post',
      policies: [new Policy('posts.view', { scopeOptions: [Scope.owned()] })],
      list: 'posts.view',
    },
  ],
})

await rbac.sync()
await rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'posts.view', 'owned')
await rbac.admin.assignPolicy({ subjectId: 'manager' }, 'posts.view', null)

interface PostRow {
  id: string
  title: string
}

interface ExtendedReadClient {
  post: {
    findMany(args?: unknown): Promise<PostRow[]>
    findFirst(args?: unknown): Promise<PostRow | null>
    findUnique(args: unknown): Promise<PostRow | null>
    count(args?: unknown): Promise<number>
    create(args: unknown): Promise<PostRow>
  }
  rbacResourceOwner: {
    findMany(args?: unknown): Promise<unknown[]>
    count(args?: unknown): Promise<number>
  }
}

const extended = client.$extends(
  rbacPrismaExtension({ rbac, resources: [{ type: 'post', model: 'post' }] }),
) as ExtendedReadClient

const cashier: Subject = { id: 'cashier' }
const manager: Subject = { id: 'manager' }
const stranger: Subject = { id: 'stranger' }

/** Runs fn in a fresh request context with the given subject set. */
const asSubject = <T>(who: Subject, fn: () => Promise<T>): Promise<T> =>
  rbac.engine.runWithRequestContext(async () => {
    rbac.engine.setRequestSubject(who)
    return fn()
  })

const ids = (rows: PostRow[]): string[] => rows.map(row => row.id).sort()

afterAll(async () => {
  rbac.dispose()
  await fixture.cleanup()
})

beforeEach(async () => {
  await client.rbacResourceOwner.deleteMany({})
  await client.post.deleteMany({})
  for (const [id, title] of [
    ['p1', 'one'],
    ['p2', 'two'],
    ['p3', 'three'],
    ['p4', 'four'],
  ] as const) {
    await client.post.create({ data: { id, title } })
  }
  await adapter.recordOwnership([
    { resourceType: 'post', resourceId: 'p1', ownerId: 'cashier', domain: '', tenantId: '' },
    { resourceType: 'post', resourceId: 'p4', ownerId: 'cashier', domain: '', tenantId: '' },
    { resourceType: 'post', resourceId: 'p2', ownerId: 'manager', domain: '', tenantId: '' },
  ])
})

describe("cashier — scoped grant ('owned') ANDs the fragment in", () => {
  test('findMany returns only owned rows', async () => {
    const rows = await asSubject(cashier, () => extended.post.findMany())
    expect(ids(rows)).toEqual(['p1', 'p4'])
  })

  test("findMany composes with the caller's where via AND — never widens", async () => {
    const four = await asSubject(cashier, () =>
      extended.post.findMany({ where: { title: 'four' } }),
    )
    expect(ids(four)).toEqual(['p4'])

    const two = await asSubject(cashier, () =>
      extended.post.findMany({ where: { title: 'two' } }),
    )
    expect(two).toEqual([])
  })

  test('findFirst sees owned rows only', async () => {
    const owned = await asSubject(cashier, () =>
      extended.post.findFirst({ where: { title: 'one' } }),
    )
    expect(owned?.id).toBe('p1')

    const unowned = await asSubject(cashier, () =>
      extended.post.findFirst({ where: { title: 'two' } }),
    )
    expect(unowned).toBeNull()
  })

  test('findUnique keeps the unique selector top-level and hides out-of-scope rows', async () => {
    const owned = await asSubject(cashier, () =>
      extended.post.findUnique({ where: { id: 'p1' } }),
    )
    expect(owned?.title).toBe('one')

    const unowned = await asSubject(cashier, () =>
      extended.post.findUnique({ where: { id: 'p2' } }),
    )
    expect(unowned).toBeNull()

    const missing = await asSubject(cashier, () =>
      extended.post.findUnique({ where: { id: 'ghost' } }),
    )
    expect(missing).toBeNull()
  })

  test('count counts only owned rows and still ANDs a caller where', async () => {
    expect(await asSubject(cashier, () => extended.post.count())).toBe(2)
    expect(
      await asSubject(cashier, () => extended.post.count({ where: { title: 'one' } })),
    ).toBe(1)
    expect(
      await asSubject(cashier, () => extended.post.count({ where: { title: 'two' } })),
    ).toBe(0)
  })

  test('write tracking still runs alongside read filtering', async () => {
    const created = await asSubject(cashier, () =>
      extended.post.create({ data: { id: 'p9', title: 'nine' } }),
    )
    expect(await adapter.isOwner('cashier', { type: 'post', id: created.id })).toBe(true)
    const rows = await asSubject(cashier, () => extended.post.findMany())
    expect(ids(rows)).toEqual(['p1', 'p4', 'p9'])
  })
})

describe('manager — unscoped grant passes through untouched', () => {
  test('findMany returns every row', async () => {
    const rows = await asSubject(manager, () => extended.post.findMany())
    expect(ids(rows)).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  test("the caller's own args survive the passthrough", async () => {
    const rows = await asSubject(manager, () =>
      extended.post.findMany({ where: { title: 'one' } }),
    )
    expect(ids(rows)).toEqual(['p1'])
  })

  test("findUnique reaches rows the manager doesn't own", async () => {
    const row = await asSubject(manager, () => extended.post.findUnique({ where: { id: 'p1' } }))
    expect(row?.title).toBe('one')
  })

  test('count counts everything', async () => {
    expect(await asSubject(manager, () => extended.post.count())).toBe(4)
  })
})

describe('stranger — no grant short-circuits before the database', () => {
  test('findMany/findFirst/findUnique/count answer []/null/null/0 with the table gone', async () => {
    await client.$executeRawUnsafe('ALTER TABLE fixture_posts RENAME TO fixture_posts_gone')
    try {
      expect(await asSubject(stranger, () => extended.post.findMany())).toEqual([])
      expect(await asSubject(stranger, () => extended.post.findFirst())).toBeNull()
      expect(
        await asSubject(stranger, () => extended.post.findUnique({ where: { id: 'p1' } })),
      ).toBeNull()
      expect(await asSubject(stranger, () => extended.post.count())).toBe(0)
    } finally {
      await client.$executeRawUnsafe('ALTER TABLE fixture_posts_gone RENAME TO fixture_posts')
    }
  })
})

describe('suppression — the subject and isInAuthz guards', () => {
  test('no request context: reads pass through unfiltered', async () => {
    expect(ids(await extended.post.findMany())).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  test('request context without a subject: reads pass through unfiltered', async () => {
    const rows = await rbac.engine.runWithRequestContext(() => extended.post.findMany())
    expect(ids(rows)).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  test('a guard resolver reads the unfiltered table while the guard still denies', async () => {
    const seen: { row: PostRow | null } = { row: null }
    await expect(
      asSubject(cashier, () =>
        rbac.engine.authorize(cashier, 'posts.view', {
          resource: async () => {
            seen.row = await extended.post.findUnique({ where: { id: 'p2' } })
            return seen.row ? { type: 'post', id: seen.row.id } : null
          },
        }),
      ),
    ).rejects.toThrow()
    expect(seen.row?.id).toBe('p2')
  })

  test('isInAuthz set directly: reads pass through unfiltered', async () => {
    const rows = await asSubject(cashier, async () => {
      rbac.engine.store.setInAuthz(true)
      try {
        return await extended.post.findMany()
      } finally {
        rbac.engine.store.setInAuthz(false)
      }
    })
    expect(ids(rows)).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  test('unregistered models are never filtered or short-circuited', async () => {
    expect(await asSubject(cashier, () => extended.rbacResourceOwner.findMany())).toHaveLength(3)
    expect(await asSubject(stranger, () => extended.rbacResourceOwner.count())).toBe(3)
  })

  test('a registration without resource definitions keeps writes-only behavior', async () => {
    const writesOnly = client.$extends(
      rbacPrismaExtension({
        rbac: { engine: rbac.engine, adapter },
        resources: [{ type: 'post', model: 'post' }],
      }),
    ) as ExtendedReadClient
    const rows = await asSubject(cashier, () => writesOnly.post.findMany())
    expect(ids(rows)).toEqual(['p1', 'p2', 'p3', 'p4'])
  })
})

describe('assignPolicy scope validation rides listPolicies scopeOptions', () => {
  test('a scope missing from the synced scopeOptions is rejected', async () => {
    expect(
      rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'posts.view', 'ghost'),
    ).rejects.toThrow(/not among the scopeOptions/)
  })
})
