/// <reference types="bun-types" />
/**
 * The Prisma extension against the real generated client on SQLite: a scope
 * written against the consumer's OWN column (fixture_posts.owner_id) is merged
 * into every query the extension intercepts for the registered model — reads,
 * single writes and bulk writes alike — keyed EXCLUSIVELY on the filter the
 * request's guard activated, never on static resource config.
 *
 * There is no separate single-row check: a request naming a row the scope
 * excludes finds nothing, which is what lets a handler answer 404.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { Policy, Scope, createGuard } from '../../src/index.js'
import { prismaAdapter, scopeExtension } from '../../src/storage/prisma/index.js'
import { makePrismaFixture } from './helpers/prisma-fixture/setup.js'
import type { Subject } from '../../src/core/types.js'

const fixture = await makePrismaFixture('kyroguard-prisma-autofilter-')
const { client } = fixture
const adapter = prismaAdapter(client)

interface PostRow {
  id: string
  title: string
  ownerId: string
}

/** What the 'sighted' scope saw while it was building its own fragment. */
let sighted: string[] = []

/** The whole point of the rewrite: a filter over the consumer's own column. */
const own = new Scope('own', 'Own posts', subject => ({ where: { ownerId: subject.id } }))

const rbac = createGuard({
  adapter,
  cache: false,
  resources: [
    {
      type: 'post',
      policies: [
        new Policy('posts.view', { scopeOptions: [own] }),
        new Policy('posts.void', { scopeOptions: [own] }),
        new Policy('posts.flag', {
          scopeOptions: [new Scope('window', 'Outside the window', () => false)],
        }),
        new Policy('posts.audit', {
          scopeOptions: [
            new Scope('sighted', 'Rows the scope itself can see', async () => {
              sighted = (await extended.post.findMany()).map(row => row.id).sort()
              return { where: { id: { in: sighted } } }
            }),
          ],
        }),
      ],
    },
  ],
})

const postResource = rbac.resources[0]!

await rbac.sync()
await rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'posts.view', 'all')
await rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'posts.void', 'own')
await rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'posts.audit', 'sighted')
await rbac.admin.assignPolicy({ subjectId: 'manager' }, 'posts.view', 'all')
await rbac.admin.assignPolicy({ subjectId: 'stranger' }, 'posts.flag', 'window')

interface ExtendedClient {
  post: {
    findMany(args?: unknown): Promise<PostRow[]>
    findFirst(args?: unknown): Promise<PostRow | null>
    findUnique(args: unknown): Promise<PostRow | null>
    count(args?: unknown): Promise<number>
    create(args: unknown): Promise<PostRow>
    update(args: unknown): Promise<PostRow>
    delete(args: unknown): Promise<PostRow>
  }
  kyroguardPolicy: {
    findMany(args?: unknown): Promise<{ id: string }[]>
    count(args?: unknown): Promise<number>
  }
}

const extended = client.$extends(
  scopeExtension({ guard: rbac, resources: [{ type: 'post', model: 'post' }] }),
) as ExtendedClient

const cashier: Subject = { id: 'cashier' }
const manager: Subject = { id: 'manager' }
const stranger: Subject = { id: 'stranger' }

/** Runs fn in a fresh request context with the given subject set — no guard. */
const asSubject = <T>(who: Subject, fn: () => Promise<T>): Promise<T> =>
  rbac.engine.runWithRequestContext(async () => {
    rbac.engine.setRequestSubject(who)
    return await fn()
  })

/** The framework guard's flow: context, subject, authorize, store the plan. */
const asGuarded = <T>(who: Subject, policy: string, fn: () => Promise<T>): Promise<T> =>
  rbac.engine.runWithRequestContext(async () => {
    rbac.engine.setRequestSubject(who)
    await rbac.engine.authorize(who, policy)
    await rbac.engine.storeFilterFor(who, policy, postResource)
    // `return await`, not `return`: under Bun, resolving the context callback
    // WITH a bare thenable subscribes to it outside the ALS frame, so the
    // extension hook would run without the request store.
    return await fn()
  })

const ids = (rows: PostRow[]): string[] => rows.map(row => row.id).sort()

const raw = client as unknown as {
  post: {
    create(args: unknown): Promise<PostRow>
    deleteMany(args?: unknown): Promise<unknown>
    findUnique(args: unknown): Promise<PostRow | null>
    findMany(args?: unknown): Promise<PostRow[]>
  }
}

const stored = (id: string): Promise<PostRow | null> => raw.post.findUnique({ where: { id } })

afterAll(async () => {
  rbac.dispose()
  await fixture.cleanup()
})

beforeEach(async () => {
  await raw.post.deleteMany({})
  for (const [id, title, ownerId] of [
    ['p1', 'one', 'cashier'],
    ['p2', 'two', 'manager'],
    ['p3', 'three', ''],
    ['p4', 'four', 'cashier'],
  ] as const) {
    await raw.post.create({ data: { id, title, ownerId } })
  }
})

describe("the void guard's scoped grant narrows every intercepted query", () => {
  test('findMany returns only the rows the scope allows', async () => {
    const rows = await asGuarded(cashier, 'posts.void', () => extended.post.findMany())
    expect(ids(rows)).toEqual(['p1', 'p4'])
  })

  test("findMany composes with the caller's where via AND — never widens it", async () => {
    const four = await asGuarded(cashier, 'posts.void', () =>
      extended.post.findMany({ where: { title: 'four' } }),
    )
    expect(ids(four)).toEqual(['p4'])

    const two = await asGuarded(cashier, 'posts.void', () =>
      extended.post.findMany({ where: { title: 'two' } }),
    )
    expect(two).toEqual([])
  })

  test('findFirst sees allowed rows only', async () => {
    const allowed = await asGuarded(cashier, 'posts.void', () =>
      extended.post.findFirst({ where: { title: 'one' } }),
    )
    expect(allowed?.id).toBe('p1')

    const excluded = await asGuarded(cashier, 'posts.void', () =>
      extended.post.findFirst({ where: { title: 'two' } }),
    )
    expect(excluded).toBeNull()
  })

  test('findUnique keeps the unique selector top-level, and an excluded row reads as missing', async () => {
    const allowed = await asGuarded(cashier, 'posts.void', () =>
      extended.post.findUnique({ where: { id: 'p1' } }),
    )
    expect(allowed?.title).toBe('one')

    const excluded = await asGuarded(cashier, 'posts.void', () =>
      extended.post.findUnique({ where: { id: 'p2' } }),
    )
    expect(excluded).toBeNull()

    const missing = await asGuarded(cashier, 'posts.void', () =>
      extended.post.findUnique({ where: { id: 'ghost' } }),
    )
    expect(missing).toBeNull()
  })

  test('count counts only allowed rows and still ANDs a caller where', async () => {
    expect(await asGuarded(cashier, 'posts.void', () => extended.post.count())).toBe(2)
    expect(
      await asGuarded(cashier, 'posts.void', () => extended.post.count({ where: { title: 'one' } })),
    ).toBe(1)
    expect(
      await asGuarded(cashier, 'posts.void', () => extended.post.count({ where: { title: 'two' } })),
    ).toBe(0)
  })

  test('update writes an allowed row and cannot reach an excluded one', async () => {
    const edited = await asGuarded(cashier, 'posts.void', () =>
      extended.post.update({ where: { id: 'p1' }, data: { title: 'edited' } }),
    )
    expect(edited.title).toBe('edited')

    await expect(
      asGuarded(cashier, 'posts.void', () =>
        extended.post.update({ where: { id: 'p2' }, data: { title: 'edited' } }),
      ),
    ).rejects.toThrow()
    expect((await stored('p2'))?.title).toBe('two')
  })

  test('delete removes an allowed row and cannot reach an excluded one', async () => {
    await asGuarded(cashier, 'posts.void', () => extended.post.delete({ where: { id: 'p4' } }))
    expect(await stored('p4')).toBeNull()

    await expect(
      asGuarded(cashier, 'posts.void', () => extended.post.delete({ where: { id: 'p2' } })),
    ).rejects.toThrow()
    expect(await stored('p2')).not.toBeNull()
  })

  test('a create is never intercepted — the row is written even when the scope excludes it', async () => {
    const own = await asGuarded(cashier, 'posts.void', () =>
      extended.post.create({ data: { id: 'p9', title: 'nine', ownerId: 'cashier' } }),
    )
    expect(own.id).toBe('p9')

    const foreign = await asGuarded(cashier, 'posts.void', () =>
      extended.post.create({ data: { id: 'p10', title: 'ten', ownerId: 'manager' } }),
    )
    expect(await stored(foreign.id)).not.toBeNull()

    const rows = await asGuarded(cashier, 'posts.void', () => extended.post.findMany())
    expect(ids(rows)).toEqual(['p1', 'p4', 'p9'])
  })
})

describe('the view guard holds the same policy unrestricted, and passes through untouched', () => {
  test('the SAME subject reads every row — the filter follows the policy being exercised', async () => {
    const viewRows = await asGuarded(cashier, 'posts.view', () => extended.post.findMany())
    expect(ids(viewRows)).toEqual(['p1', 'p2', 'p3', 'p4'])

    const voidRows = await asGuarded(cashier, 'posts.void', () => extended.post.findMany())
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

describe('the flag guard allows the request, then its scope folds closed', () => {
  test('findMany/findFirst/findUnique/count answer []/null/null/0 without touching the table', async () => {
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

  test('a single update or delete finds nothing rather than writing', async () => {
    await expect(
      asGuarded(stranger, 'posts.flag', () =>
        extended.post.update({ where: { id: 'p1' }, data: { title: 'edited' } }),
      ),
    ).rejects.toThrow()
    expect((await stored('p1'))?.title).toBe('one')

    await expect(
      asGuarded(stranger, 'posts.flag', () => extended.post.delete({ where: { id: 'p1' } })),
    ).rejects.toThrow()
    expect(await stored('p1')).not.toBeNull()
  })
})

describe("suppression — requests with no activated filter, and the engine's own queries", () => {
  test('no request context: reads pass through unfiltered', async () => {
    expect(ids(await extended.post.findMany())).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  test('a subject without a guard: reads pass through unfiltered — no static fallback', async () => {
    const rows = await asSubject(cashier, () => extended.post.findMany())
    expect(ids(rows)).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  test('a scope reads the unfiltered table while building its fragment, even under a narrower active filter', async () => {
    sighted = []
    const filter = await asGuarded(cashier, 'posts.void', () =>
      rbac.engine.filterFor(cashier, 'posts.audit', postResource),
    )

    expect(sighted).toEqual(['p1', 'p2', 'p3', 'p4'])
    expect(filter).toEqual({ kind: 'where', where: { id: { in: ['p1', 'p2', 'p3', 'p4'] } } })
  })

  test('isInAuthz set directly: reads pass through unfiltered even with a filter active', async () => {
    const rows = await asGuarded(cashier, 'posts.void', async () => {
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
    const synced = (await client.kyroguardPolicy.findMany({})).length
    expect(synced).toBeGreaterThan(0)

    expect(
      await asGuarded(cashier, 'posts.void', () => extended.kyroguardPolicy.findMany()),
    ).toHaveLength(synced)
    expect(await asGuarded(stranger, 'posts.flag', () => extended.kyroguardPolicy.count())).toBe(
      synced,
    )
  })
})

describe('assignPolicy scope validation rides listPolicies scopeOptions', () => {
  test('a scope missing from the synced scopeOptions is rejected', async () => {
    expect(rbac.admin.assignPolicy({ subjectId: 'cashier' }, 'posts.view', 'ghost')).rejects.toThrow(
      /not among the scopeOptions/,
    )
  })
})
