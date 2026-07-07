/// <reference types="bun-types" />
/**
 * Guard-driven automatic read filtering through kyroguardPrismaExtension against
 * the real generated client on SQLite: findMany/findFirst/findUnique/count
 * are intercepted for registered models and keyed on the request's
 * activeFilters plan. A route guarded by the 'owned'-scoped void grant reads
 * only owned rows, the SAME subject on a route guarded by the null view grant
 * reads everything, a guard-allowed grant whose filter folds closed
 * short-circuits to []/null/0 without touching the table, unguarded reads are
 * never filtered, and the isInAuthz guard keeps engine-internal queries
 * unfiltered.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { Policy, Scope, createKyroguard } from '../../src/index.js'
import { prismaAdapter, kyroguardPrismaExtension } from '../../src/storage/prisma/index.js'
import { makePrismaFixture } from './helpers/prisma-fixture/setup.js'
import type { Subject } from '../../src/core/types.js'

const fixture = await makePrismaFixture('rbac-prisma-autofilter-')
const { client } = fixture
const adapter = prismaAdapter(client)

const rbac = createKyroguard({
  adapter,
  cache: false,
  resources: [
    {
      type: 'post',
      policies: [
        new Policy('posts.view', { scopeOptions: [Scope.owned()] }),
        new Policy('posts.void', { scopeOptions: [Scope.owned()] }),
        new Policy('posts.flag', {
          scopeOptions: [new Scope('window', 'Window', () => true, () => false)],
        }),
      ],
    },
  ],
})

const postResource = rbac.resources[0]!

await rbac.sync()
await rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'posts.view', 'all')
await rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'posts.void', 'owned')
await rbac.admin.assignPolicy({ subjectId: 'manager' }, 'posts.view', 'all')
await rbac.admin.assignPolicy({ subjectId: 'stranger' }, 'posts.flag', 'window')

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
  kyroguardPrismaExtension({ rbac, resources: [{ type: 'post', model: 'post' }] }),
) as ExtendedReadClient

const cashier: Subject = { id: 'cashier' }
const manager: Subject = { id: 'manager' }
const stranger: Subject = { id: 'stranger' }

const p1 = { type: 'post', id: 'p1' }

/** Runs fn in a fresh request context with the given subject set — no guard. */
const asSubject = <T>(who: Subject, fn: () => Promise<T>): Promise<T> =>
  rbac.engine.runWithRequestContext(async () => {
    rbac.engine.setRequestSubject(who)
    return await fn()
  })

/** The framework guard's flow: context, subject, authorize, store the plan. */
const asGuarded = <T>(
  who: Subject,
  policy: string,
  fn: () => Promise<T>,
  target?: { type: string; id: string },
): Promise<T> =>
  rbac.engine.runWithRequestContext(async () => {
    rbac.engine.setRequestSubject(who)
    await rbac.engine.authorize(who, policy, target ? { resource: () => target } : undefined)
    await rbac.engine.storeFilterFor(who, policy, postResource)
    // `return await`, not `return`: under Bun, resolving the context callback
    // WITH a bare thenable subscribes to it outside the ALS frame, so the
    // extension hook would run without the request store.
    return await fn()
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

describe("void guard — the 'owned'-scoped grant ANDs the fragment in", () => {
  test('findMany returns only owned rows', async () => {
    const rows = await asGuarded(cashier, 'posts.void', () => extended.post.findMany(), p1)
    expect(ids(rows)).toEqual(['p1', 'p4'])
  })

  test("findMany composes with the caller's where via AND — never widens", async () => {
    const four = await asGuarded(
      cashier,
      'posts.void',
      () => extended.post.findMany({ where: { title: 'four' } }),
      p1,
    )
    expect(ids(four)).toEqual(['p4'])

    const two = await asGuarded(
      cashier,
      'posts.void',
      () => extended.post.findMany({ where: { title: 'two' } }),
      p1,
    )
    expect(two).toEqual([])
  })

  test('findFirst sees owned rows only', async () => {
    const owned = await asGuarded(
      cashier,
      'posts.void',
      () => extended.post.findFirst({ where: { title: 'one' } }),
      p1,
    )
    expect(owned?.id).toBe('p1')

    const unowned = await asGuarded(
      cashier,
      'posts.void',
      () => extended.post.findFirst({ where: { title: 'two' } }),
      p1,
    )
    expect(unowned).toBeNull()
  })

  test('findUnique keeps the unique selector top-level and hides out-of-scope rows', async () => {
    const owned = await asGuarded(
      cashier,
      'posts.void',
      () => extended.post.findUnique({ where: { id: 'p1' } }),
      p1,
    )
    expect(owned?.title).toBe('one')

    const unowned = await asGuarded(
      cashier,
      'posts.void',
      () => extended.post.findUnique({ where: { id: 'p2' } }),
      p1,
    )
    expect(unowned).toBeNull()

    const missing = await asGuarded(
      cashier,
      'posts.void',
      () => extended.post.findUnique({ where: { id: 'ghost' } }),
      p1,
    )
    expect(missing).toBeNull()
  })

  test('count counts only owned rows and still ANDs a caller where', async () => {
    expect(await asGuarded(cashier, 'posts.void', () => extended.post.count(), p1)).toBe(2)
    expect(
      await asGuarded(
        cashier,
        'posts.void',
        () => extended.post.count({ where: { title: 'one' } }),
        p1,
      ),
    ).toBe(1)
    expect(
      await asGuarded(
        cashier,
        'posts.void',
        () => extended.post.count({ where: { title: 'two' } }),
        p1,
      ),
    ).toBe(0)
  })

  test('write tracking still runs alongside read filtering; the next guard sees the new row', async () => {
    const created = await asGuarded(
      cashier,
      'posts.void',
      () => extended.post.create({ data: { id: 'p9', title: 'nine' } }),
      p1,
    )
    expect(await adapter.isOwner('cashier', { type: 'post', id: created.id })).toBe(true)
    const rows = await asGuarded(cashier, 'posts.void', () => extended.post.findMany(), p1)
    expect(ids(rows)).toEqual(['p1', 'p4', 'p9'])
  })
})

describe('view guard — the null grant passes through untouched', () => {
  test('the SAME subject reads every row — the filter follows the exercised policy', async () => {
    const viewRows = await asGuarded(cashier, 'posts.view', () => extended.post.findMany())
    expect(ids(viewRows)).toEqual(['p1', 'p2', 'p3', 'p4'])

    const voidRows = await asGuarded(cashier, 'posts.void', () => extended.post.findMany(), p1)
    expect(ids(voidRows)).toEqual(['p1', 'p4'])
  })

  test("the caller's own args survive the passthrough", async () => {
    const rows = await asGuarded(manager, 'posts.view', () =>
      extended.post.findMany({ where: { title: 'one' } }),
    )
    expect(ids(rows)).toEqual(['p1'])
  })

  test("findUnique reaches rows the manager doesn't own", async () => {
    const row = await asGuarded(manager, 'posts.view', () =>
      extended.post.findUnique({ where: { id: 'p1' } }),
    )
    expect(row?.title).toBe('one')
  })

  test('count counts everything', async () => {
    expect(await asGuarded(manager, 'posts.view', () => extended.post.count())).toBe(4)
  })
})

describe('flag guard — allowed at the guard, folded closed on the list path', () => {
  test('findMany/findFirst/findUnique/count answer []/null/null/0 with the table gone', async () => {
    await client.$executeRawUnsafe('ALTER TABLE fixture_posts RENAME TO fixture_posts_gone')
    try {
      expect(await asGuarded(stranger, 'posts.flag', () => extended.post.findMany())).toEqual([])
      expect(await asGuarded(stranger, 'posts.flag', () => extended.post.findFirst())).toBeNull()
      expect(
        await asGuarded(stranger, 'posts.flag', () =>
          extended.post.findUnique({ where: { id: 'p1' } }),
        ),
      ).toBeNull()
      expect(await asGuarded(stranger, 'posts.flag', () => extended.post.count())).toBe(0)
    } finally {
      await client.$executeRawUnsafe('ALTER TABLE fixture_posts_gone RENAME TO fixture_posts')
    }
  })
})

describe('suppression — unguarded requests and the isInAuthz guard', () => {
  test('no request context: reads pass through unfiltered', async () => {
    expect(ids(await extended.post.findMany())).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  test('a subject without a guard: reads pass through unfiltered — no static fallback', async () => {
    const rows = await asSubject(cashier, () => extended.post.findMany())
    expect(ids(rows)).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  test('a guard resolver reads the unfiltered table while a filter is active — and the guard still denies', async () => {
    const seen: { row: PostRow | null } = { row: null }
    await expect(
      asGuarded(
        cashier,
        'posts.void',
        () =>
          rbac.engine.authorize(cashier, 'posts.void', {
            resource: async () => {
              seen.row = await extended.post.findUnique({ where: { id: 'p2' } })
              return seen.row ? { type: 'post', id: seen.row.id } : null
            },
          }),
        p1,
      ),
    ).rejects.toThrow()
    expect(seen.row?.id).toBe('p2')
  })

  test('isInAuthz set directly: reads pass through unfiltered even with a filter active', async () => {
    const rows = await asGuarded(
      cashier,
      'posts.void',
      async () => {
        rbac.engine.store.setInAuthz(true)
        try {
          return await extended.post.findMany()
        } finally {
          rbac.engine.store.setInAuthz(false)
        }
      },
      p1,
    )
    expect(ids(rows)).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  test('unregistered models are never filtered or short-circuited', async () => {
    expect(
      await asGuarded(cashier, 'posts.void', () => extended.rbacResourceOwner.findMany(), p1),
    ).toHaveLength(3)
    expect(
      await asGuarded(stranger, 'posts.flag', () => extended.rbacResourceOwner.count()),
    ).toBe(3)
  })
})

describe('assignPolicy scope validation rides listPolicies scopeOptions', () => {
  test('a scope missing from the synced scopeOptions is rejected', async () => {
    expect(
      rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'posts.view', 'ghost'),
    ).rejects.toThrow(/not among the scopeOptions/)
  })
})
