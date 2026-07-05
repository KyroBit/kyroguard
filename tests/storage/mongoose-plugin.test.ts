/// <reference types="bun-types" />
/**
 * rbacMongoosePlugin behavior on a real mongod (mongodb-memory-server):
 * automatic ownership tracking through document middleware, ownership cleanup
 * on findOneAndDelete, deprecated query scoping via pre(/^find/) (still works,
 * warns once), and the DOCUMENTED gap that updateMany fires no document
 * middleware and therefore records nothing.
 */

import mongoose from 'mongoose'

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { inProcessBus } from '../../src/cache/bus.js'
import { RbacEngine } from '../../src/core/engine.js'
import { mongooseAdapter, rbacModels, rbacMongoosePlugin } from '../../src/storage/mongoose/index.js'
import { makeConnection, mongoAvailable, stopMongo } from './helpers/mongo.js'
import type { Subject } from '../../src/core/types.js'

const available = await mongoAvailable()

afterAll(stopMongo)

if (!available) {
  test.skip('rbacMongoosePlugin suite (mongod unavailable)', () => {})
} else {
  const connection = await makeConnection()
  const adapter = mongooseAdapter(connection)
  await adapter.ensureSchema?.()
  const models = rbacModels(connection)
  const engine = new RbacEngine({
    adapter,
    scopes: new Map(),
    cache: null,
    bus: inProcessBus(),
  })

  interface PostDoc {
    title: string
    authorId: string
    branchId: string
  }

  const postSchema = new mongoose.Schema<PostDoc>({
    title: { type: String, required: true },
    authorId: { type: String, required: true },
    branchId: { type: String, required: true },
  })
  // Capture the deprecation warn fired by the first (and only the first)
  // query-scoping registration in this process.
  const deprecationWarns: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    deprecationWarns.push(args.map(String).join(' '))
  }
  try {
    rbacMongoosePlugin(postSchema as unknown as mongoose.Schema, {
      rbac: { engine, adapter },
      type: 'post',
      queryScopes: {
        own: subject => ({ authorId: subject.id }),
        branch: subject => ({ branchId: subject.tenant_id }),
      },
      domains: {
        // Two policies listing overlapping scopes: the plugin must dedupe the
        // scope names and $or-combine the two distinct filters.
        admin: {
          'admin.posts.read': ['own', 'branch'],
          'admin.posts.write': ['own'],
        },
      },
    })
    rbacMongoosePlugin(new mongoose.Schema({}) as unknown as mongoose.Schema, {
      rbac: { engine, adapter },
      type: 'other',
      domains: { admin: {} },
    })
  } finally {
    console.warn = originalWarn
  }
  const Post = connection.model<PostDoc>('Post', postSchema)

  const subject: Subject = { id: 'u1', domain: 'admin', tenant_id: 'b1' }

  /** Runs fn in a fresh request context with the given subject set. */
  const asSubject = <T>(who: Subject, fn: () => Promise<T>): Promise<T> =>
    engine.runWithRequestContext(async () => {
      engine.setRequestSubject(who)
      return fn()
    })

  const isOwner = (ownerId: string, id: unknown): Promise<boolean> =>
    adapter.isOwner(ownerId, { type: 'post', id: String(id) })

  describe('rbacMongoosePlugin', () => {
    beforeEach(async () => {
      await Post.deleteMany({})
      await models.resourceOwner.deleteMany({})
    })

    test('(g) domains/queryScopes config warns exactly once per process', () => {
      const rbacWarns = deprecationWarns.filter(line => line.includes('deprecated'))
      expect(rbacWarns).toHaveLength(1)
      expect(rbacWarns[0]).toContain('rbacMongoosePlugin')
      expect(rbacWarns[0]).toContain('filterFor')
    })

    test("(a) doc.save() inside engine.store context records ownership with the subject's domain/tenant", async () => {
      const post = await asSubject(subject, () =>
        Post.create({ title: 'one', authorId: 'u1', branchId: 'b1' }),
      )

      expect(await isOwner('u1', post._id)).toBe(true)
      expect(await isOwner('u2', post._id)).toBe(false)

      const row = await models.resourceOwner
        .findOne({ resourceType: 'post', resourceId: post._id.toString() })
        .lean()
      expect(row).not.toBeNull()
      expect(row?.ownerId).toBe('u1')
      expect(row?.domain).toBe('admin')
      expect(row?.tenantId).toBe('b1')
    })

    test('(b) Model.insertMany records ownership for every inserted doc', async () => {
      const docs = await asSubject(subject, () =>
        Post.insertMany([
          { title: 'first', authorId: 'u1', branchId: 'b1' },
          { title: 'second', authorId: 'u1', branchId: 'b1' },
          { title: 'third', authorId: 'u1', branchId: 'b1' },
        ]),
      )

      expect(docs).toHaveLength(3)
      for (const doc of docs) {
        expect(await isOwner('u1', doc._id)).toBe(true)
      }
      expect(
        await models.resourceOwner.countDocuments({ resourceType: 'post', ownerId: 'u1' }),
      ).toBe(3)
    })

    test('(c) save with no ALS context records no ownership and does not throw', async () => {
      // Outside any engine.store context: middleware must be a silent no-op.
      const post = await Post.create({ title: 'orphan', authorId: 'u1', branchId: 'b1' })

      expect(await isOwner('u1', post._id)).toBe(false)
      expect(await models.resourceOwner.countDocuments({})).toBe(0)
    })

    test('(d) findOneAndDelete removes ownership for the deleted doc only', async () => {
      const [kept, deleted] = await asSubject(subject, async () => {
        const first = await Post.create({ title: 'kept', authorId: 'u1', branchId: 'b1' })
        const second = await Post.create({ title: 'doomed', authorId: 'u1', branchId: 'b1' })
        return [first, second] as const
      })
      expect(await isOwner('u1', deleted._id)).toBe(true)

      // No subject context: no query scoping interferes with the delete.
      await Post.findOneAndDelete({ _id: deleted._id })

      expect(await isOwner('u1', deleted._id)).toBe(false)
      expect(await isOwner('u1', kept._id)).toBe(true)
    })

    test('(e) find() applies the $or of both configured scope filters for a matching domain', async () => {
      // Seeded outside any subject context so no ownership noise is recorded.
      await Post.create({ title: 'mine-other-branch', authorId: 'u1', branchId: 'b9' })
      await Post.create({ title: 'branch-b1', authorId: 'u2', branchId: 'b1' })
      await Post.create({ title: 'unrelated', authorId: 'u2', branchId: 'b9' })

      // subject u1@admin/b1: own → authorId u1, branch → branchId b1.
      const titles = await asSubject(subject, async () => {
        const found = await Post.find({}).lean()
        return found.map(doc => doc.title).sort()
      })
      expect(titles).toEqual(['branch-b1', 'mine-other-branch'])

      // The scope filter composes with an existing filter ($and), it does not
      // replace it: authorId u2 AND (own OR branch) → only 'branch-b1'.
      const narrowed = await asSubject(subject, async () => {
        const found = await Post.find({ authorId: 'u2' }).lean()
        return found.map(doc => doc.title)
      })
      expect(narrowed).toEqual(['branch-b1'])
    })

    test('(e) find() is unfiltered for a subject whose domain has no domains config', async () => {
      await Post.create({ title: 'a', authorId: 'u1', branchId: 'b9' })
      await Post.create({ title: 'b', authorId: 'u2', branchId: 'b1' })
      await Post.create({ title: 'c', authorId: 'u2', branchId: 'b9' })

      const titles = await asSubject(
        { id: 'u9', domain: 'customer', tenant_id: 'b1' },
        async () => {
          const found = await Post.find({}).lean()
          return found.map(doc => doc.title).sort()
        },
      )
      expect(titles).toEqual(['a', 'b', 'c'])

      // Domain-less subject ('' sentinel) has no entry either → unfiltered.
      const domainless = await asSubject({ id: 'u9' }, () => Post.countDocuments({}))
      expect(domainless).toBe(3)
    })

    test('(f) updateMany does NOT record ownership — documented middleware gap', async () => {
      // Created outside any subject context: no owner on record.
      const post = await Post.create({ title: 'before', authorId: 'u1', branchId: 'b1' })
      expect(await isOwner('u1', post._id)).toBe(false)

      const result = await asSubject(subject, () =>
        Post.updateMany({ _id: post._id }, { $set: { title: 'after' } }),
      )
      expect(result.modifiedCount).toBe(1)

      const updated = await Post.findById(post._id).lean()
      expect(updated?.title).toBe('after')
      // Documented LIMITATION in src/storage/mongoose/plugin.ts: updateMany
      // fires no document middleware, so ownership is NOT tracked here —
      // callers must invoke rbac.ownership.record() explicitly on that path.
      expect(await isOwner('u1', post._id)).toBe(false)
      expect(await models.resourceOwner.countDocuments({})).toBe(0)
    })
  })
}
