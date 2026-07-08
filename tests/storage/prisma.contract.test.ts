/// <reference types="bun-types" />
/**
 * Runs the executable storage contract (S1–S23) against the Prisma adapter on
 * SQLite. The fixture generates the client from
 * helpers/prisma-fixture/schema.prisma and pushes it to a unique tmp database
 * file; every contract case starts from wiped tables (children before
 * parents), which is far cheaper than a push per case.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { prismaAdapter } from '../../src/storage/prisma/index.js'
import { runStorageAdapterContractSuite } from '../../src/testing/index.js'
import { makePrismaFixture } from './helpers/prisma-fixture/setup.js'

const fixture = await makePrismaFixture('kyroguard-prisma-contract-')
const { client } = fixture

afterAll(async () => {
  await fixture.cleanup()
})

/** Fresh state per contract case: wipe all six tables in dependency order. */
const resetDb = async (): Promise<void> => {
  await client.kyroguardPolicyGroupPolicy.deleteMany({})
  await client.kyroguardUserPolicyGroup.deleteMany({})
  await client.kyroguardUserPolicy.deleteMany({})
  await client.kyroguardResourceOwner.deleteMany({})
  await client.kyroguardPolicy.deleteMany({})
  await client.kyroguardPolicyGroup.deleteMany({})
}

runStorageAdapterContractSuite({
  name: 'prisma',
  makeAdapter: async () => {
    await resetDb()
    return { adapter: prismaAdapter(client) }
  },
  test: { describe, it: test, expect, beforeEach, afterAll },
})
