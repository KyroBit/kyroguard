/// <reference types="bun-types" />
/**
 * scopePlugin behaviour on a real mongod (mongodb-memory-server): the
 * request's activated filter narrows every query the plugin hooks, scopes
 * build their fragments against the unfiltered collection, and writes through
 * a document save or a raw collection op are untouched.
 */

import mongoose from 'mongoose'

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { inProcessBus } from '../../src/cache/bus.js'
import { GuardEngine } from '../../src/core/engine.js'
import { Scope } from '../../src/core/scope.js'
import { mongooseAdapter, scopePlugin } from '../../src/storage/mongoose/index.js'
import { makeConnection, mongoAvailable, stopMongo } from './helpers/mongo.js'
import type { ResourceDefinition } from '../../src/core/policy.js'
import type { Subject } from '../../src/core/types.js'

const available = await mongoAvailable()

afterAll(stopMongo)

if (!available) {
  test.skip('scopePlugin suite (mongod unavailable)', () => {})
} else {
  const connection = await makeConnection()
  const adapter = mongooseAdapter(connection)
  await adapter.ensureSchema?.()

  // The scope is written against the consumer's OWN field — kyroguard stores no
  // ownership of its own.
  const scopes = new Map<string, Scope>([
    ['owned', new Scope('owned', 'Own posts', subject => ({ where: { authorId: subject.id } }))],
  ])
  const engine = new GuardEngine({
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
  scopePlugin(postSchema as unknown as mongoose.Schema, {
    guard: { engine },
    type: 'post',
  })
  const Post = connection.model<PostDoc>('Post', postSchema)
  postResource.table = Post

  const observedInAuthz: boolean[] = []
  scopes.set(
    'peek',
    new Scope('peek', 'Peek', async () => {
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

  const seedBothAuthors = async (): Promise<void> => {
    await Post.create({ title: 'cashier-1', authorId: 'cashier', branchId: 'b1' })
    await Post.create({ title: 'cashier-2', authorId: 'cashier', branchId: 'b1' })
    await Post.create({ title: 'manager-1', authorId: 'manager', branchId: 'b1' })
  }

  const titlesFor = (who: Subject, filter: Record<string, unknown> = {}): Promise<string[]> =>
    asGuarded(who, async () => {
      const found = await Post.find(filter).lean()
      return found.map(doc => doc.title).sort()
    })

  describe('scopePlugin', () => {
    beforeEach(async () => {
      await Post.deleteMany({})
      observedInAuthz.length = 0
    })

    test("a guarded read returns only the rows the grant's scope fragment allows", async () => {
      await seedBothAuthors()

      expect(await titlesFor(cashier)).toEqual(['cashier-1', 'cashier-2'])
      expect(await asGuarded(cashier, () => Post.countDocuments({}))).toBe(2)
      expect(
        await asGuarded(cashier, () => Post.findOne({ title: 'manager-1' }).lean()),
      ).toBeNull()
    })

    test("the grant's fragment composes with the caller's own filter, it does not replace it", async () => {
      await seedBothAuthors()

      expect(await titlesFor(cashier, { title: 'cashier-2' })).toEqual(['cashier-2'])
      expect(await titlesFor(cashier, { title: 'manager-1' })).toEqual([])
    })

    test('an unscoped grant activates no fragment — reads see every row', async () => {
      await seedBothAuthors()

      expect(await titlesFor(manager)).toEqual(['cashier-1', 'cashier-2', 'manager-1'])
      expect(await asGuarded(manager, () => Post.countDocuments({}))).toBe(3)
    })

    test('a subject holding no grant reads nothing rather than everything', async () => {
      await seedBothAuthors()

      expect(await titlesFor(nobody)).toEqual([])
      expect(await asGuarded(nobody, () => Post.countDocuments({}))).toBe(0)
      expect(await asGuarded(nobody, () => Post.findOne({}).lean())).toBeNull()
    })

    test('a subject whose request activated no filter reads unfiltered — there is no static fallback', async () => {
      await seedBothAuthors()

      const found = await asSubject(cashier, () => Post.find({}).lean())
      expect(found.map(doc => doc.title).sort()).toEqual(['cashier-1', 'cashier-2', 'manager-1'])
      expect(await asSubject(cashier, () => Post.countDocuments({}))).toBe(3)
    })

    test('outside any request context reads are unfiltered', async () => {
      await seedBothAuthors()

      const found = await Post.find({}).lean()
      expect(found.map(doc => doc.title).sort()).toEqual(['cashier-1', 'cashier-2', 'manager-1'])
      expect(await Post.countDocuments({})).toBe(3)
    })

    test("a scope's own queries see the unfiltered collection while it builds its fragment", async () => {
      await seedBothAuthors()

      expect(await titlesFor(peeker)).toEqual(['cashier-1', 'cashier-2', 'manager-1'])
      expect(observedInAuthz).toEqual([true])
      await asSubject(peeker, async () => {
        await Post.find({}).lean()
        expect(engine.store.isInAuthz()).toBe(false)
      })
    })

    test("a fragment built while another subject's filter is active still sees every row", async () => {
      await seedBothAuthors()

      // peek's filter queries Post itself; without isInAuthz suppression it
      // would be narrowed by the cashier's active 'owned' plan (2 docs) — or
      // re-enter the plugin's read hook and recurse.
      await asGuarded(cashier, async () => {
        const plan = await engine.filterFor(peeker, 'admin.posts.read', postResource)
        if (plan.kind !== 'where') throw new Error(`expected where, got ${plan.kind}`)
        const fragment = plan.where as { _id: { $in: unknown[] } }
        expect(fragment._id.$in).toHaveLength(3)
      })
    })

    test('a document save passes through untouched, with or without a request context', async () => {
      const outside = await Post.create({ title: 'outside', authorId: 'cashier', branchId: 'b1' })
      const inside = await asGuarded(cashier, () =>
        Post.create({ title: 'inside', authorId: 'manager', branchId: 'b1' }),
      )

      const stored = await Post.find({}).lean()
      expect(stored.map(doc => doc.title).sort()).toEqual(['inside', 'outside'])
      expect(stored.find(doc => doc._id.equals(outside._id))?.authorId).toBe('cashier')
      // The save is not rewritten to the acting subject, and the active
      // 'owned' plan does not reject a row the subject could not read back.
      expect(stored.find(doc => doc._id.equals(inside._id))?.authorId).toBe('manager')
    })

    test('raw collection operations bypass the plugin entirely — the documented escape hatch', async () => {
      await seedBothAuthors()

      const seen = await asGuarded(cashier, () => Post.collection.find({}).toArray())
      expect(seen).toHaveLength(3)

      await asGuarded(cashier, () => Post.collection.deleteMany({}))
      expect(await Post.collection.countDocuments({})).toBe(0)
    })
  })
}
