/// <reference types="bun-types" />
/**
 * Runs the query-integration contract (Q1–Q7) against scopeExtension on the
 * real generated client (SQLite). The fixture Post model carries only id and
 * title, so title doubles as the contract's mark field.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { Policy, Scope, createGuard } from '../../src/index.js'
import { prismaAdapter, scopeExtension } from '../../src/storage/prisma/index.js'
import { runQueryIntegrationContractSuite } from '../../src/testing/index.js'
import type { IntegrationHarness } from '../../src/testing/index.js'
import type { Subject } from '../../src/core/types.js'
import { makePrismaFixture } from './helpers/prisma-fixture/setup.js'

const subject: Subject = { id: 'u1' }
const cleanups: Array<() => Promise<unknown>> = []

afterAll(async () => {
  for (const close of cleanups.reverse()) await close()
})

async function makeHarness(): Promise<{ harness: IntegrationHarness; cleanup: () => Promise<void> }> {
  const fixture = await makePrismaFixture('rbac-prisma-contract-')
  const { client } = fixture
  const adapter = prismaAdapter(client)

  let allowed: string[] = []
  const allowedScope = new Scope('allowed', 'Allowed rows', () =>
    allowed.length ? { where: { id: { in: allowed } } } : false,
  )

  const rbac = createGuard({
    adapter,
    cache: false,
    resources: [{ type: 'post', policies: [new Policy('posts.write', { scopeOptions: [allowedScope] })] }],
  })
  const resource = rbac.resources[0]!

  await rbac.sync()
  await rbac.admin.assignPolicy({ subjectId: 'u1' }, 'posts.write', 'allowed')

  const raw = client as unknown as {
    post: {
      createMany(args: unknown): Promise<unknown>
      findMany(args?: unknown): Promise<{ id: string; title: string }[]>
    }
  }
  await raw.post.createMany({
    data: [
      { id: 'r1', title: 'seed' },
      { id: 'r2', title: 'seed' },
      { id: 'r3', title: 'seed' },
    ],
  })

  const extended = client.$extends(
    scopeExtension({ guard: rbac, resources: [{ type: 'post', model: 'post' }] }),
  ) as unknown as {
    post: {
      findMany(args?: unknown): Promise<{ id: string }[]>
      updateMany(args: unknown): Promise<unknown>
      deleteMany(args?: unknown): Promise<unknown>
    }
  }

  const ids = async (where?: unknown): Promise<string[]> =>
    (await raw.post.findMany(where ? { where } : undefined)).map(row => row.id).sort()

  const harness: IntegrationHarness = {
    guarded: (next, fn) =>
      rbac.engine.store.run(async () => {
        allowed = next
        rbac.engine.store.setSubject(subject)
        await rbac.engine.storeFilterFor(subject, 'posts.write', resource)
        return await fn()
      }),
    unguarded: fn =>
      rbac.engine.store.run(async () => {
        rbac.engine.store.setSubject(subject)
        return await fn()
      }),
    rows: {
      read: async () => (await extended.post.findMany()).map(row => row.id).sort(),
      all: () => ids(),
    },
    markAll: async mark => {
      await extended.post.updateMany({ data: { title: mark } })
    },
    marked: mark => ids({ title: mark }),
    deleteAll: async () => {
      await extended.post.deleteMany({})
    },
  }

  return {
    harness,
    cleanup: async () => {
      rbac.dispose()
      await fixture.cleanup()
    },
  }
}

runQueryIntegrationContractSuite({
  name: 'prisma / scopeExtension',
  makeHarness,
  test: { describe, it: test, expect, beforeEach, afterAll },
})
