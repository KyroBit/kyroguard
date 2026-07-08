/// <reference types="bun-types" />
/**
 * Adapter close() semantics: close() releases the backing client/connection
 * so a short-lived process (the CLI) can exit. Regression for the release
 * blocker where `kyroguard sync` never terminated under the Prisma and
 * Mongoose adapters — neither implemented close(), so the CLI's
 * `finally { adapter.close() }` was a no-op and the open pool kept the
 * event loop alive.
 */

import { afterAll, describe, expect, test } from 'bun:test'

import { prismaAdapter } from '../../src/storage/prisma/index.js'
import { mongooseAdapter } from '../../src/storage/mongoose/index.js'
import { makeConnection, mongoAvailable, stopMongo } from './helpers/mongo.js'
import type { PrismaClientLike, PrismaModelDelegateLike } from '../../src/storage/prisma/index.js'

const available = await mongoAvailable()

afterAll(stopMongo)

describe('prismaAdapter close()', () => {
  /** close() must only disconnect — any model access is a bug. */
  function unusedDelegate(): PrismaModelDelegateLike {
    const reject = (): Promise<never> =>
      Promise.reject(new Error('close() must not touch the models'))
    return {
      findMany: reject,
      findFirst: reject,
      findUnique: reject,
      create: reject,
      createMany: reject,
      update: reject,
      updateMany: reject,
      upsert: reject,
      deleteMany: reject,
    }
  }

  test('disconnects the client, exactly once per call', async () => {
    let disconnects = 0
    const client: PrismaClientLike = {
      kyroguardPolicy: unusedDelegate(),
      kyroguardPolicyGroup: unusedDelegate(),
      kyroguardPolicyGroupPolicy: unusedDelegate(),
      kyroguardUserPolicyGroup: unusedDelegate(),
      kyroguardUserPolicy: unusedDelegate(),
      kyroguardResourceOwner: unusedDelegate(),
      $transaction: () => Promise.reject(new Error('close() must not open a transaction')),
      $disconnect: async () => {
        disconnects += 1
      },
    }

    const adapter = prismaAdapter(client)
    expect(typeof adapter.close).toBe('function')

    await adapter.close?.()
    expect(disconnects).toBe(1)

    // Prisma's $disconnect is itself idempotent — the adapter just forwards.
    await adapter.close?.()
    expect(disconnects).toBe(2)
  })
})

describe('mongooseAdapter close()', () => {
  if (!available) {
    test.skip('closes the connection (mongod unavailable)', () => {})
  } else {
    test('closes the connection it was given; a second close resolves', async () => {
      const connection = await makeConnection()
      const adapter = mongooseAdapter(connection)
      expect(typeof adapter.close).toBe('function')
      expect(connection.readyState).toBe(1) // connected

      await adapter.close?.()
      expect(connection.readyState).toBe(0) // disconnected

      await adapter.close?.()
      expect(connection.readyState).toBe(0)
    })
  }
})
