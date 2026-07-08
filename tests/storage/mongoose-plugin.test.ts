/// <reference types="bun-types" />
/**
 * kyroguardMongoosePlugin behavior on a real mongod (mongodb-memory-server):
 * automatic ownership tracking through document middleware, ownership cleanup
 * on findOneAndDelete, guard-driven read filtering on find/countDocuments
 * (keyed on the request's activeFilters plan), and the DOCUMENTED gap that
 * updateMany fires no document middleware and therefore records nothing.
 */

import mongoose from 'mongoose'

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { inProcessBus } from '../../src/cache/bus.js'
import { KyroguardEngine } from '../../src/core/engine.js'
import { Scope } from '../../src/core/scope.js'
import { mongooseAdapter, kyroguardModels, kyroguardMongoosePlugin } from '../../src/storage/mongoose/index.js'
import { makeConnection, mongoAvailable, stopMongo } from './helpers/mongo.js'
import type { ResourceDefinition } from '../../src/core/policy.js'
import type { Subject } from '../../src/core/types.js'

const available = await mongoAvailable()

afterAll(stopMongo)

if (!available) {
  test.skip('kyroguardMongoosePlugin suite (mongod unavailable)', () => {})
} else {
  const connection = await makeConnection()
  const adapter = mongooseAdapter(connection)
  await adapter.ensureSchema?.()
  const models = kyroguardModels(connection)

  const scopes = new Map<string, Scope>([['owned', Scope.owned()]])
  const engine = new KyroguardEngine({
    adapter,
    scopes,
    cache: null,
    bus: inProcessBus(),
    superBypass: true,
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
  const postResource: ResourceDefinition = { type: 'post', policies: [] }
  kyroguardMongoosePlugin(postSchema as unknown as mongoose.Schema, {
    guard: { engine, adapter },
    type: 'post',
  })
  const Post = connection.model<PostDoc>('Post', postSchema)
  postResource.table = Post

  const observedInAuthz: boolean[] = []
  scopes.set(
    'peek',
    new Scope('peek', 'Peek', () => false, async () => {
      observedInAuthz.push(engine.store.isInAuthz())
      const rows = await Post.find({}).lean()
      return { where: { _id: { $in: rows.map(row => row._id) } } }
    }),
  )

  await adapter.upsertPolicies([
    {
      name: 'admin.posts.read',
      domain: 'admin',
      label: 'Read posts',
      scopeOptions: ['owned', 'peek'],
      dependsOn: [],
    },
  ])
  const refFor = (id: string) => ({ subjectId: id, domain: 'admin', tenantId: 'b1' })
  await adapter.assignPolicy(refFor('cashier'), 'admin.posts.read', 'owned')
  await adapter.assignPolicy(refFor('manager'), 'admin.posts.read', null)
  await adapter.assignPolicy(refFor('peeker'), 'admin.posts.read', 'peek')

  const cashier: Subject = { id: 'cashier', domain: 'admin', tenant_id: 'b1' }
  const manager: Subject = { id: 'manager', domain: 'admin', tenant_id: 'b1' }
  const nobody: Subject = { id: 'nobody', domain: 'admin', tenant_id: 'b1' }
  const peeker: Subject = { id: 'peeker', domain: 'admin', tenant_id: 'b1' }

  /** Runs fn in a fresh request context with the given subject set — no guard. */
  const asSubject = <T>(who: Subject, fn: () => Promise<T>): Promise<T> =>
    engine.runWithRequestContext(async () => {
      engine.setRequestSubject(who)
      return fn()
    })

  /** The framework guard's flow: context, subject, then store the exercised policy's plan. */
  const asGuarded = <T>(who: Subject, fn: () => Promise<T>): Promise<T> =>
    engine.runWithRequestContext(async () => {
      engine.setRequestSubject(who)
      await engine.storeFilterFor(who, 'admin.posts.read', postResource)
      // `return await`, not `return`: under Bun, resolving the context
      // callback WITH a bare thenable (a mongoose Query) subscribes to it
      // outside the ALS frame, so the pre-find hook would run storeless.
      return await fn()
    })

  const isOwner = (ownerId: string, id: unknown): Promise<boolean> =>
    adapter.isOwner(ownerId, { type: 'post', id: String(id) })

  const seedBothAuthors = async (): Promise<void> => {
    await asSubject(cashier, async () => {
      await Post.create({ title: 'cashier-1', authorId: 'cashier', branchId: 'b1' })
      await Post.create({ title: 'cashier-2', authorId: 'cashier', branchId: 'b1' })
    })
    await asSubject(manager, async () => {
      await Post.create({ title: 'manager-1', authorId: 'manager', branchId: 'b1' })
    })
  }

  const titlesFor = (who: Subject, filter: Record<string, unknown> = {}): Promise<string[]> =>
    asGuarded(who, async () => {
      const found = await Post.find(filter).lean()
      return found.map(doc => doc.title).sort()
    })

  describe('kyroguardMongoosePlugin', () => {
    beforeEach(async () => {
      await Post.deleteMany({})
      await models.resourceOwner.deleteMany({})
      observedInAuthz.length = 0
    })

    test("(a) doc.save() inside engine.store context records ownership with the subject's domain/tenant", async () => {
      const post = await asSubject(cashier, () =>
        Post.create({ title: 'one', authorId: 'cashier', branchId: 'b1' }),
      )

      expect(await isOwner('cashier', post._id)).toBe(true)
      expect(await isOwner('manager', post._id)).toBe(false)

      const row = await models.resourceOwner
        .findOne({ resourceType: 'post', resourceId: post._id.toString() })
        .lean()
      expect(row).not.toBeNull()
      expect(row?.ownerId).toBe('cashier')
      expect(row?.domain).toBe('admin')
      expect(row?.tenantId).toBe('b1')
    })

    test('(b) Model.insertMany records ownership for every inserted doc', async () => {
      const docs = await asSubject(cashier, () =>
        Post.insertMany([
          { title: 'first', authorId: 'cashier', branchId: 'b1' },
          { title: 'second', authorId: 'cashier', branchId: 'b1' },
          { title: 'third', authorId: 'cashier', branchId: 'b1' },
        ]),
      )

      expect(docs).toHaveLength(3)
      for (const doc of docs) {
        expect(await isOwner('cashier', doc._id)).toBe(true)
      }
      expect(
        await models.resourceOwner.countDocuments({ resourceType: 'post', ownerId: 'cashier' }),
      ).toBe(3)
    })

    test('(c) save with no ALS context records no ownership and does not throw', async () => {
      // Outside any engine.store context: middleware must be a silent no-op.
      const post = await Post.create({ title: 'orphan', authorId: 'cashier', branchId: 'b1' })

      expect(await isOwner('cashier', post._id)).toBe(false)
      expect(await models.resourceOwner.countDocuments({})).toBe(0)
    })

    test('(d) findOneAndDelete removes ownership for the deleted doc only', async () => {
      const [kept, deleted] = await asSubject(cashier, async () => {
        const first = await Post.create({ title: 'kept', authorId: 'cashier', branchId: 'b1' })
        const second = await Post.create({ title: 'doomed', authorId: 'cashier', branchId: 'b1' })
        return [first, second] as const
      })
      expect(await isOwner('cashier', deleted._id)).toBe(true)

      // No subject context: no read filtering interferes with the delete.
      await Post.findOneAndDelete({ _id: deleted._id })

      expect(await isOwner('cashier', deleted._id)).toBe(false)
      expect(await isOwner('cashier', kept._id)).toBe(true)
    })

    test("(e) cashier guarded by the 'owned' grant: find and countDocuments see only owned docs", async () => {
      await seedBothAuthors()

      expect(await titlesFor(cashier)).toEqual(['cashier-1', 'cashier-2'])
      expect(await asGuarded(cashier, () => Post.countDocuments({}))).toBe(2)

      // The plan composes with the caller's filter ($and), it does not replace it.
      expect(await titlesFor(cashier, { title: 'cashier-2' })).toEqual(['cashier-2'])
      expect(await titlesFor(cashier, { title: 'manager-1' })).toEqual([])
      expect(
        await asGuarded(cashier, () => Post.findOne({ title: 'manager-1' }).lean()),
      ).toBeNull()
    })

    test('(e) manager guarded by the unscoped grant: plan is all — find and countDocuments are unfiltered', async () => {
      await seedBothAuthors()

      expect(await titlesFor(manager)).toEqual(['cashier-1', 'cashier-2', 'manager-1'])
      expect(await asGuarded(manager, () => Post.countDocuments({}))).toBe(3)
    })

    test('(e) no grant: the stored plan is none — empty results without matching any doc', async () => {
      await seedBothAuthors()

      expect(await titlesFor(nobody)).toEqual([])
      expect(await asGuarded(nobody, () => Post.countDocuments({}))).toBe(0)
      expect(await asGuarded(nobody, () => Post.findOne({}).lean())).toBeNull()
    })

    test('(e) a subject WITHOUT a guard reads unfiltered — no static fallback exists', async () => {
      await seedBothAuthors()

      const found = await asSubject(cashier, () => Post.find({}).lean())
      expect(found.map(doc => doc.title).sort()).toEqual(['cashier-1', 'cashier-2', 'manager-1'])
      expect(await asSubject(cashier, () => Post.countDocuments({}))).toBe(3)
    })

    test('(e) no ALS context: find is unfiltered', async () => {
      await seedBothAuthors()

      const found = await Post.find({}).lean()
      expect(found.map(doc => doc.title).sort()).toEqual(['cashier-1', 'cashier-2', 'manager-1'])
      expect(await Post.countDocuments({})).toBe(3)
    })

    test('(e) scope filter halves run suppressed: their model queries see the unfiltered collection', async () => {
      await seedBothAuthors()

      expect(await titlesFor(peeker)).toEqual(['cashier-1', 'cashier-2', 'manager-1'])
      expect(observedInAuthz).toEqual([true])
      await asSubject(peeker, async () => {
        await Post.find({}).lean()
        expect(engine.store.isInAuthz()).toBe(false)
      })
    })

    test("(e) a filter half building while another guard's filter is active still sees every doc", async () => {
      await seedBothAuthors()

      // peek's filter half queries Post itself; without isInAuthz suppression
      // it would be filtered by the cashier's active 'owned' plan (2 docs) —
      // or re-enter the plugin's read hook and recurse.
      await asGuarded(cashier, async () => {
        const plan = await engine.filterFor(peeker, 'admin.posts.read', postResource)
        if (plan.kind !== 'where') throw new Error(`expected where, got ${plan.kind}`)
        const fragment = plan.where as { _id: { $in: unknown[] } }
        expect(fragment._id.$in).toHaveLength(3)
      })
    })

    test('(f) updateMany does NOT record ownership — documented middleware gap', async () => {
      // Created outside any subject context: no owner on record.
      const post = await Post.create({ title: 'before', authorId: 'cashier', branchId: 'b1' })
      expect(await isOwner('cashier', post._id)).toBe(false)

      const result = await asSubject(cashier, () =>
        Post.updateMany({ _id: post._id }, { $set: { title: 'after' } }),
      )
      expect(result.modifiedCount).toBe(1)

      const updated = await Post.findById(post._id).lean()
      expect(updated?.title).toBe('after')
      // Documented LIMITATION in src/storage/mongoose/plugin.ts: updateMany
      // fires no document middleware, so ownership is NOT tracked here —
      // callers must invoke rbac.ownership.record() explicitly on that path.
      expect(await isOwner('cashier', post._id)).toBe(false)
      expect(await models.resourceOwner.countDocuments({})).toBe(0)
    })
  })
}
