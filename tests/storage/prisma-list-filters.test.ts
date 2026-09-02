/// <reference types="bun-types" />
/**
 * The Prisma adapter's listFilters: the fragment composition the engine calls
 * when one policy carries two scopes. Executed against the real generated
 * client on SQLite, so the composed object is proven to be a where Prisma
 * accepts — not just the shape the engine expects.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { prismaAdapter } from '../../src/storage/prisma/index.js'
import { makePrismaFixture } from './helpers/prisma-fixture/setup.js'

const fixture = await makePrismaFixture('kyroguard-prisma-filters-')
const { client } = fixture
const adapter = prismaAdapter(client)
const filters = adapter.listFilters!

interface PostRow {
  id: string
}

const posts = client.post as unknown as {
  create(args: unknown): Promise<PostRow>
  deleteMany(args?: unknown): Promise<unknown>
  findMany(args?: unknown): Promise<PostRow[]>
}

const matching = (where: unknown): Promise<string[]> =>
  posts.findMany({ where }).then(rows => rows.map(row => row.id).sort())

afterAll(async () => {
  await fixture.cleanup()
})

beforeEach(async () => {
  await posts.deleteMany({})
  for (const [id, ownerId] of [
    ['p1', 'u1'],
    ['p2', 'u2'],
    ['p3', 'u3'],
  ] as const) {
    await posts.create({ data: { id, title: id, ownerId } })
  }
})

describe('prisma listFilters', () => {
  test('the adapter advertises listFiltering, so the engine may OR-combine scopes', () => {
    expect(adapter.capabilities.listFiltering).toBe(true)
  })

  test('or matches the union of the fragments, never their intersection', async () => {
    const combined = filters.or([{ ownerId: 'u1' }, { ownerId: 'u2' }])

    expect(combined).toEqual({ OR: [{ ownerId: 'u1' }, { ownerId: 'u2' }] })
    expect(await matching(combined)).toEqual(['p1', 'p2'])
  })

  test('or over a single fragment still matches exactly that fragment', async () => {
    expect(await matching(filters.or([{ ownerId: 'u3' }]))).toEqual(['p3'])
  })

  test('none matches no row at all, on a table that is full', async () => {
    expect(await matching(filters.none())).toEqual([])
  })

  test('none stays empty when OR-combined with itself — a denied scope adds nothing', async () => {
    expect(await matching(filters.or([filters.none(), filters.none()]))).toEqual([])
  })
})
