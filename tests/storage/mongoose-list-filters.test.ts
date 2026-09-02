/// <reference types="bun-types" />
/**
 * The Mongoose adapter's fragment composition, proven against a real mongod:
 * the engine hands `or` the fragments two scopes returned and hands the result
 * straight to mongo, so what it builds has to be a query mongo actually runs.
 */

import mongoose from 'mongoose'

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { mongooseAdapter } from '../../src/storage/mongoose/index.js'
import { makeConnection, mongoAvailable, stopMongo } from './helpers/mongo.js'

const available = await mongoAvailable()

afterAll(stopMongo)

if (!available) {
  test.skip('mongoose fragment composition (mongod unavailable)', () => {})
} else {
  const connection = await makeConnection()
  const adapter = mongooseAdapter(connection)
  await adapter.ensureSchema?.()

  interface PostDoc {
    title: string
    authorId: string
    branchId: string
  }
  const Post = connection.model<PostDoc>(
    'Post',
    new mongoose.Schema<PostDoc>({
      title: { type: String, required: true },
      authorId: { type: String, required: true },
      branchId: { type: String, required: true },
    }),
  )

  const filters = adapter.listFilters!

  const titlesMatching = async (where: unknown): Promise<string[]> =>
    (await Post.find(where as Record<string, unknown>).lean()).map(doc => doc.title).sort()

  describe('mongoose adapter fragment composition', () => {
    beforeEach(async () => {
      await Post.deleteMany({})
      await Post.create([
        { title: 'mine', authorId: 'u1', branchId: 'b1' },
        { title: 'my-branch', authorId: 'u2', branchId: 'b1' },
        { title: 'elsewhere', authorId: 'u3', branchId: 'b2' },
      ])
    })

    test('capabilities advertise list filtering', () => {
      expect(adapter.capabilities.listFiltering).toBe(true)
      expect(adapter.listFilters).toBeDefined()
    })

    test('or admits a document that any one fragment admits', async () => {
      // The fragments two scopes would return, written against the
      // consumer's own fields — kyroguard stores nothing about these rows.
      const authored = { authorId: 'u1' }
      const sameBranch = { branchId: 'b2' }

      const either = filters.or([authored, sameBranch])
      expect(either).toEqual({ $or: [authored, sameBranch] })
      expect(await titlesMatching(either)).toEqual(['elsewhere', 'mine'])
    })

    test('none admits nothing', async () => {
      expect(await titlesMatching(filters.none())).toEqual([])
    })
  })
}
