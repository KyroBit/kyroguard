/// <reference types="bun-types" />
/**
 * trackingExtension behavior against a real generated client on SQLite:
 * automatic ownership tracking on create / createMany / upsert, the DOCUMENTED
 * gap that createMany can only record client-provided ids (Prisma returns
 * only a count), the silent no-op without a request subject, and the
 * guarantee that a failing ownership write rejects the caller.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { inProcessBus } from '../../src/cache/bus.js'
import { GuardEngine } from '../../src/core/engine.js'
import { prismaAdapter, trackingExtension } from '../../src/storage/prisma/index.js'
import { makePrismaFixture } from './helpers/prisma-fixture/setup.js'
import type { Subject } from '../../src/core/types.js'

const fixture = await makePrismaFixture('rbac-prisma-ext-')
const { client } = fixture

const adapter = prismaAdapter(client)
const engine = new GuardEngine({ adapter, scopes: new Map(), cache: null, bus: inProcessBus() })

// The generated $extends signature is a project-specific mapped type; the
// fixture client is structural, so the extension object goes through as-is.
const extended = client.$extends(
  trackingExtension({
    guard: { engine, adapter },
    resources: [{ type: 'post', model: 'post' }],
  }),
) as {
  post: {
    create(args: unknown): Promise<{ id: string; title: string }>
    createMany(args: unknown): Promise<{ count: number }>
    upsert(args: unknown): Promise<{ id: string; title: string }>
  }
}

afterAll(async () => {
  engine.dispose()
  await fixture.cleanup()
})

const subject: Subject = { id: 'u1', domain: 'admin', tenant_id: 'b1' }

/** Runs fn in a fresh request context with the given subject set. */
const asSubject = <T>(who: Subject, fn: () => Promise<T>): Promise<T> =>
  engine.runWithRequestContext(async () => {
    engine.setRequestSubject(who)
    return fn()
  })

const isOwner = (ownerId: string, id: string): Promise<boolean> =>
  adapter.isOwner(ownerId, { type: 'post', id })

describe('trackingExtension', () => {
  beforeEach(async () => {
    await client.kyroguardResourceOwner.deleteMany({})
    await client.post.deleteMany({})
  })

  test("(a) create inside the request context records ownership with the subject's domain/context", async () => {
    const post = await asSubject(subject, () => extended.post.create({ data: { title: 'one' } }))

    expect(typeof post.id).toBe('string')
    expect(await isOwner('u1', post.id)).toBe(true)
    expect(await isOwner('u2', post.id)).toBe(false)

    const row: { ownerId: unknown; domain: unknown; tenantId: unknown } | null =
      await client.kyroguardResourceOwner.findFirst({
        where: { resourceType: 'post', resourceId: post.id },
      })
    expect(row).not.toBeNull()
    expect(row?.ownerId).toBe('u1')
    expect(row?.domain).toBe('admin')
    expect(row?.tenantId).toBe('b1')
  })

  test('(b) createMany with client-provided ids records ownership for every input row', async () => {
    const result = await asSubject(subject, () =>
      extended.post.createMany({
        data: [
          { id: 'p-1', title: 'first' },
          { id: 'p-2', title: 'second' },
          { id: 'p-3', title: 'third' },
        ],
      }),
    )

    expect(result.count).toBe(3)
    expect(await isOwner('u1', 'p-1')).toBe(true)
    expect(await isOwner('u1', 'p-2')).toBe(true)
    expect(await isOwner('u1', 'p-3')).toBe(true)
  })

  test('(b) createMany rows WITHOUT client-provided ids record nothing — documented gap', async () => {
    // Prisma's createMany returns only { count }; db-generated ids cannot be
    // read back, so ownership is not tracked for them (see the extension's
    // JSDoc) — callers must use rbac.ownership.record() on that path.
    const result = await asSubject(subject, () =>
      extended.post.createMany({ data: [{ title: 'no-client-id' }] }),
    )

    expect(result.count).toBe(1)
    expect(await client.kyroguardResourceOwner.findMany({})).toHaveLength(0)
  })

  test('(c) create with no ALS subject records no ownership and does not throw', async () => {
    // Outside any engine.store context: the hook must be a silent no-op.
    const post = await extended.post.create({ data: { title: 'orphan' } })

    expect(await isOwner('u1', post.id)).toBe(false)
    expect(await client.kyroguardResourceOwner.findMany({})).toHaveLength(0)
  })

  test('(d) a failing ownership write rejects the caller', async () => {
    await client.$executeRawUnsafe(
      'ALTER TABLE kyroguard_resource_owners RENAME TO kyroguard_resource_owners_gone',
    )
    try {
      // The post row itself commits (extensions run outside a transaction),
      // but the awaited ownership write fails → the caller must see it.
      await expect(
        asSubject(subject, () => extended.post.create({ data: { title: 'doomed' } })),
      ).rejects.toThrow()
    } finally {
      await client.$executeRawUnsafe(
        'ALTER TABLE kyroguard_resource_owners_gone RENAME TO kyroguard_resource_owners',
      )
    }
  })

  test('(e) upsert records ownership on both its create and update paths', async () => {
    const args = {
      where: { id: 'up-1' },
      update: { title: 'v2' },
      create: { id: 'up-1', title: 'v1' },
    }

    const created = await asSubject(subject, () => extended.post.upsert(args))
    expect(created.title).toBe('v1')
    expect(await isOwner('u1', 'up-1')).toBe(true)

    // Update path: create-vs-update cannot be distinguished, so ownership is
    // (re)recorded idempotently — still exactly one owner row.
    await client.kyroguardResourceOwner.deleteMany({})
    const updated = await asSubject(subject, () => extended.post.upsert(args))
    expect(updated.title).toBe('v2')
    expect(await isOwner('u1', 'up-1')).toBe(true)
    expect(
      await client.kyroguardResourceOwner.findMany({ where: { resourceId: 'up-1' } }),
    ).toHaveLength(1)
  })
})
