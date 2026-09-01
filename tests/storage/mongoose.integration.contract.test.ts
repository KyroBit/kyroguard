/// <reference types="bun-types" />
/**
 * Runs the query-integration contract (Q1–Q7) against trackingPlugin on a real
 * mongod (mongodb-memory-server).
 */

import mongoose from 'mongoose'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import { inProcessBus } from '../../src/cache/bus.js'
import { GuardEngine } from '../../src/core/engine.js'
import { Scope } from '../../src/core/scope.js'
import { mongooseAdapter, trackingPlugin } from '../../src/storage/mongoose/index.js'
import { runQueryIntegrationContractSuite } from '../../src/testing/index.js'
import type { IntegrationHarness } from '../../src/testing/index.js'
import type { ResourceDefinition } from '../../src/core/policy.js'
import type { Subject } from '../../src/core/types.js'
import { makeConnection, mongoAvailable, stopMongo } from './helpers/mongo.js'

const available = await mongoAvailable()

afterAll(stopMongo)

if (!available) {
  test.skip('query integration contract — mongoose (mongod unavailable)', () => {})
} else {
  const subject: Subject = { id: 'u1', domain: 'admin', tenant_id: 'b1' }

  async function makeHarness(): Promise<{
    harness: IntegrationHarness
    cleanup: () => Promise<void>
  }> {
    const connection = await makeConnection()
    const adapter = mongooseAdapter(connection)
    await adapter.ensureSchema?.()

    let allowed: string[] = []
    const allowedScope = new Scope(
      'allowed',
      'Allowed rows',
      (_s, resource) => (resource ? allowed.includes(resource.id) : false),
      () => (allowed.length ? { where: { key: { $in: allowed } } } : false),
    )

    const engine = new GuardEngine({
      adapter,
      scopes: new Map([['allowed', allowedScope]]),
      cache: null,
      bus: inProcessBus(),
    })

    interface NoteDoc {
      key: string
      mark: string | null
    }

    const noteSchema = new mongoose.Schema<NoteDoc>({
      key: { type: String, required: true },
      mark: { type: String, default: null },
    })
    const resource: ResourceDefinition = { type: 'note', policies: [] }
    trackingPlugin(noteSchema as unknown as mongoose.Schema, {
      guard: { engine, adapter },
      type: 'note',
    })
    const Note = connection.model<NoteDoc>('Note', noteSchema)
    resource.table = Note

    await adapter.upsertPolicies([
      {
        name: 'notes.write',
        domain: 'admin',
        label: 'Write notes',
        scopeOptions: ['allowed'],
        dependsOn: [],
      },
    ])
    await adapter.assignPolicy(
      { subjectId: 'u1', domain: 'admin', tenantId: 'b1' },
      'notes.write',
      'allowed',
    )

    // Seeded outside any context: the contract is about filtering, not ownership.
    await Note.collection.insertMany([
      { key: 'r1', mark: null },
      { key: 'r2', mark: null },
      { key: 'r3', mark: null },
    ])

    const keys = async (filter: Record<string, unknown> = {}): Promise<string[]> =>
      (await Note.collection.find(filter).toArray()).map(doc => doc.key as string).sort()

    const harness: IntegrationHarness = {
      guarded: (next, fn) =>
        engine.runWithRequestContext(async () => {
          allowed = next
          engine.setRequestSubject(subject)
          await engine.storeFilterFor(subject, 'notes.write', resource)
          return await fn()
        }),
      unguarded: fn =>
        engine.runWithRequestContext(async () => {
          engine.setRequestSubject(subject)
          return await fn()
        }),
      rows: {
        read: async () => (await Note.find({}).lean()).map(doc => doc.key).sort(),
        all: () => keys(),
      },
      markAll: async mark => {
        await Note.updateMany({}, { $set: { mark } })
      },
      marked: mark => keys({ mark }),
      deleteAll: async () => {
        await Note.deleteMany({})
      },
    }

    return {
      harness,
      cleanup: async () => {
        await connection.close()
      },
    }
  }

  runQueryIntegrationContractSuite({
    name: 'mongoose / trackingPlugin',
    makeHarness,
    test: { describe, it: test, expect, beforeEach, afterAll },
  })
}
