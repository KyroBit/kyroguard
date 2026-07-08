/// <reference types="bun-types" />
/**
 * Mongoose adapter access-relation semantics (S13, S21–S23) and list-filter
 * fragments on a real mongod: relation-keyed ownership upserts, isOwner's
 * relation-'owner' restriction, getAccess/removeAccess, the ensureSchema
 * and listFilters ID-list fragments (owned / inTenant / granted / or / none)
 * applied through a real model with ObjectId _ids.
 */

import mongoose from 'mongoose'

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { mongooseAdapter, kyroguardModels } from '../../src/storage/mongoose/index.js'
import { makeConnection, mongoAvailable, stopMongo } from './helpers/mongo.js'
import type { ResourceDefinition } from '../../src/core/policy.js'
import type { OwnershipEntry } from '../../src/storage/contract.js'

const available = await mongoAvailable()

afterAll(stopMongo)

function entry(overrides: Partial<OwnershipEntry> & Pick<OwnershipEntry, 'resourceId' | 'ownerId'>): OwnershipEntry {
  return {
    resourceType: 'post',
    domain: '',
    tenantId: '',
    ...overrides,
  }
}

if (!available) {
  test.skip('mongoose access-relation suite (mongod unavailable)', () => {})
} else {
  const connection = await makeConnection()
  const adapter = mongooseAdapter(connection)
  await adapter.ensureSchema?.()
  const models = kyroguardModels(connection)

  interface PostDoc {
    title: string
  }
  const Post = connection.model<PostDoc>(
    'Post',
    new mongoose.Schema<PostDoc>({ title: { type: String, required: true } }),
  )
  const postResource: ResourceDefinition = { type: 'post', policies: [], table: Post }

  interface NoteDoc {
    _id: string
    title: string
  }
  const Note = connection.model<NoteDoc>(
    'Note',
    new mongoose.Schema<NoteDoc>({
      _id: { type: String, required: true },
      title: { type: String, required: true },
    }),
  )
  const noteResource: ResourceDefinition = { type: 'note', policies: [], table: Note }

  const filters = adapter.listFilters!

  describe('mongoose access relations', () => {
    beforeEach(async () => {
      await Post.deleteMany({})
      await Note.deleteMany({})
      await models.resourceOwner.deleteMany({})
    })

    test('capabilities advertise listFiltering', () => {
      expect(adapter.capabilities.listFiltering).toBe(true)
      expect(adapter.listFilters).toBeDefined()
      expect(adapter.getAccess).toBeDefined()
      expect(adapter.removeAccess).toBeDefined()
    })

    test('recordOwnership stores relation "owner" when omitted and upserts per relation (S22)', async () => {
      await adapter.recordOwnership([entry({ resourceId: 'r1', ownerId: 'u1' })])
      await adapter.recordOwnership([entry({ resourceId: 'r1', ownerId: 'u1' })])

      const rows = await models.resourceOwner.find({ resourceType: 'post', resourceId: 'r1' }).lean()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.relation).toBe('owner')

      await adapter.recordOwnership([
        entry({ resourceId: 'r1', ownerId: 'u1', relation: 'granted' }),
      ])
      await adapter.recordOwnership([
        entry({ resourceId: 'r1', ownerId: 'u1', relation: 'granted', domain: 'admin', tenantId: 'b1' }),
      ])

      const after = await models.resourceOwner
        .find({ resourceType: 'post', resourceId: 'r1' })
        .lean()
      expect(after).toHaveLength(2)
      const granted = after.find(row => row.relation === 'granted')
      expect(granted?.domain).toBe('admin')
      expect(granted?.tenantId).toBe('b1')
    })

    test('isOwner matches ONLY relation-"owner" rows (S22)', async () => {
      await adapter.recordOwnership([
        entry({ resourceId: 'r1', ownerId: 'u1', relation: 'granted' }),
      ])
      expect(await adapter.isOwner('u1', { type: 'post', id: 'r1' })).toBe(false)

      await adapter.recordOwnership([entry({ resourceId: 'r1', ownerId: 'u1' })])
      expect(await adapter.isOwner('u1', { type: 'post', id: 'r1' })).toBe(true)
    })

    test('getAccess returns every relation entry for the resource (S21)', async () => {
      await adapter.recordOwnership([
        entry({ resourceId: 'r1', ownerId: 'u1' }),
        entry({ resourceId: 'r1', ownerId: 'u2', relation: 'granted', tenantId: 'b1' }),
        entry({ resourceId: 'r2', ownerId: 'u1' }),
      ])

      const access = await adapter.getAccess!({ type: 'post', id: 'r1' })
      expect(access).toHaveLength(2)
      const byOwner = new Map(access.map(a => [a.ownerId, a]))
      expect(byOwner.get('u1')?.relation).toBe('owner')
      expect(byOwner.get('u2')?.relation).toBe('granted')
      expect(byOwner.get('u2')?.tenantId).toBe('b1')
    })

    test('removeAccess removes only the matching owner/relation entries (S23)', async () => {
      await adapter.recordOwnership([
        entry({ resourceId: 'r1', ownerId: 'u1' }),
        entry({ resourceId: 'r1', ownerId: 'u1', relation: 'granted' }),
        entry({ resourceId: 'r1', ownerId: 'u2', relation: 'granted' }),
      ])

      await adapter.removeAccess!('u1', { type: 'post', id: 'r1' }, 'granted')
      let access = await adapter.getAccess!({ type: 'post', id: 'r1' })
      expect(access.map(a => `${a.ownerId}:${a.relation ?? ''}`).sort()).toEqual([
        'u1:owner',
        'u2:granted',
      ])

      await adapter.removeAccess!('u1', { type: 'post', id: 'r1' })
      access = await adapter.getAccess!({ type: 'post', id: 'r1' })
      expect(access.map(a => `${a.ownerId}:${a.relation ?? ''}`)).toEqual(['u2:granted'])
    })

    test('removeOwnership removes every relation for the resource (S13)', async () => {
      await adapter.recordOwnership([
        entry({ resourceId: 'r1', ownerId: 'u1' }),
        entry({ resourceId: 'r1', ownerId: 'u2', relation: 'granted' }),
        entry({ resourceId: 'r2', ownerId: 'u1' }),
      ])

      await adapter.removeOwnership({ type: 'post', id: 'r1' })
      expect(await adapter.getAccess!({ type: 'post', id: 'r1' })).toHaveLength(0)
      expect(await adapter.getAccess!({ type: 'post', id: 'r2' })).toHaveLength(1)
    })
  })

  describe('mongoose listFilters', () => {
    beforeEach(async () => {
      await Post.deleteMany({})
      await Note.deleteMany({})
      await models.resourceOwner.deleteMany({})
    })

    async function seedPosts(): Promise<{ owned: string; granted: string; other: string }> {
      const [ownedDoc, grantedDoc, otherDoc] = await Post.create([
        { title: 'owned-by-u1' },
        { title: 'granted-to-u1' },
        { title: 'owned-by-u2' },
      ])
      const owned = ownedDoc!._id.toString()
      const granted = grantedDoc!._id.toString()
      const other = otherDoc!._id.toString()
      await adapter.recordOwnership([
        entry({ resourceId: owned, ownerId: 'u1', tenantId: 'b1' }),
        entry({ resourceId: granted, ownerId: 'u1', relation: 'granted', tenantId: 'b2' }),
        entry({ resourceId: other, ownerId: 'u2', tenantId: 'b1' }),
      ])
      return { owned, granted, other }
    }

    test('owned() matches only relation-"owner" rows for the subject', async () => {
      const { owned } = await seedPosts()

      const fragment = await filters.owned('u1', postResource, null)
      expect(fragment).not.toBe(false)
      const where = (fragment as { where: unknown }).where as {
        _id: { $in: unknown[] }
      }
      expect(where._id.$in).toHaveLength(1)
      expect(where._id.$in[0]).toBeInstanceOf(mongoose.Types.ObjectId)

      const docs = await Post.find(where).lean()
      expect(docs.map(doc => doc._id.toString())).toEqual([owned])
    })

    test('granted() matches only relation-"granted" rows for the subject', async () => {
      const { granted } = await seedPosts()

      const fragment = (await filters.granted('u1', postResource, null)) as { where: unknown }
      const docs = await Post.find(fragment.where as Record<string, unknown>).lean()
      expect(docs.map(doc => doc._id.toString())).toEqual([granted])
    })

    test('inTenant() matches all entries of the tenant and never the "" sentinel', async () => {
      const { owned, other } = await seedPosts()

      const fragment = (await filters.inTenant('b1', postResource, null)) as { where: unknown }
      const docs = await Post.find(fragment.where as Record<string, unknown>).lean()
      expect(docs.map(doc => doc._id.toString()).sort()).toEqual([owned, other].sort())

      await adapter.recordOwnership([entry({ resourceId: owned, ownerId: 'u3' })])
      const sentinel = (await filters.inTenant('', postResource, null)) as { where: unknown }
      expect(await Post.find(sentinel.where as Record<string, unknown>).lean()).toEqual([])
    })

    test('string _id models get uncast string ids', async () => {
      await Note.create([
        { _id: 'n1', title: 'mine' },
        { _id: 'n2', title: 'theirs' },
      ])
      await adapter.recordOwnership([
        entry({ resourceType: 'note', resourceId: 'n1', ownerId: 'u1' }),
        entry({ resourceType: 'note', resourceId: 'n2', ownerId: 'u2' }),
      ])

      const fragment = (await filters.owned('u1', noteResource, null)) as { where: unknown }
      const where = fragment.where as { _id: { $in: unknown[] } }
      expect(where._id.$in).toEqual(['n1'])
      const docs = await Note.find(where).lean()
      expect(docs.map(doc => doc._id)).toEqual(['n1'])
    })

    test('no matching rows yields an empty $in that matches nothing', async () => {
      await seedPosts()
      const fragment = (await filters.owned('nobody', postResource, null)) as { where: unknown }
      expect((fragment.where as { _id: { $in: unknown[] } })._id.$in).toEqual([])
      expect(await Post.find(fragment.where as Record<string, unknown>).lean()).toEqual([])
    })

    test('or() combines fragments with $or; none() matches nothing', async () => {
      const { owned, granted } = await seedPosts()

      const ownedFragment = (await filters.owned('u1', postResource, null)) as { where: unknown }
      const grantedFragment = (await filters.granted('u1', postResource, null)) as {
        where: unknown
      }
      const combined = filters.or([ownedFragment.where, grantedFragment.where])
      expect(combined).toEqual({ $or: [ownedFragment.where, grantedFragment.where] })

      const docs = await Post.find(combined as Record<string, unknown>).lean()
      expect(docs.map(doc => doc._id.toString()).sort()).toEqual([owned, granted].sort())

      expect(filters.none()).toEqual({ _id: { $in: [] } })
      expect(await Post.find(filters.none() as Record<string, unknown>).lean()).toEqual([])
    })
  })
}
