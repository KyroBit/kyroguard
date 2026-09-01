/// <reference types="bun-types" />
/**
 * Runs the query-integration contract (Q1–Q7) against trackedDb on PGlite.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { asc, eq, inArray } from 'drizzle-orm'
import { pgTable, text } from 'drizzle-orm/pg-core'

import { createGuard, Policy, Scope } from '../../src/index.js'
import type { ResourceDefinition, Subject } from '../../src/index.js'
import { drizzleAdapter, trackedDb } from '../../src/storage/drizzle/index.js'
import * as pgSchema from '../../src/storage/drizzle/schema/pg.js'
import { runQueryIntegrationContractSuite } from '../../src/testing/index.js'
import type { IntegrationHarness } from '../../src/testing/index.js'
import { makePgDb } from './helpers/pg.js'

const notes = pgTable('notes', {
  id: text('id').primaryKey(),
  mark: text('mark'),
})

const DDL = `CREATE TABLE "notes" ("id" text PRIMARY KEY, "mark" text);`

const subject: Subject = { id: 'u1' }
const cleanups: Array<() => Promise<unknown>> = []

afterAll(async () => {
  for (const close of cleanups.reverse()) await close()
})

async function makeHarness(): Promise<{ harness: IntegrationHarness; cleanup: () => Promise<void> }> {
  const pg = await makePgDb(DDL)
  const adapter = drizzleAdapter(pg.db, { schema: pgSchema })

  // The allowed set is swapped per case; the scope reads it at filter time.
  let allowed: string[] = []
  const allowedScope = new Scope(
    'allowed',
    'Allowed rows',
    (_s, resource) => (resource ? allowed.includes(resource.id) : false),
    () => (allowed.length ? { where: inArray(notes.id, allowed) } : false),
  )

  const resource: ResourceDefinition = {
    type: 'note',
    policies: [new Policy('notes.write', { scopeOptions: [allowedScope] })],
    table: notes,
  }

  const rbac = createGuard({ adapter, resources: [resource], cache: false })
  await rbac.sync()
  await rbac.admin.assignPolicy({ subjectId: 'u1' }, 'notes.write', 'allowed')

  await pg.db.insert(notes).values([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }])

  const db = trackedDb(pg.db, { guard: { engine: rbac.engine, adapter }, resources: [resource] })

  const harness: IntegrationHarness = {
    guarded: (next, fn) =>
      rbac.engine.store.run(async () => {
        allowed = next
        rbac.engine.store.setSubject(subject)
        await rbac.engine.storeFilterFor(subject, 'notes.write', resource)
        return await fn()
      }),
    unguarded: fn =>
      rbac.engine.store.run(async () => {
        rbac.engine.store.setSubject(subject)
        return await fn()
      }),
    rows: {
      read: async () => (await db.select().from(notes)).map(row => row.id),
      all: async () => (await pg.db.select().from(notes).orderBy(asc(notes.id))).map(row => row.id),
    },
    markAll: async mark => {
      await db.update(notes).set({ mark })
    },
    marked: async mark =>
      (await pg.db.select().from(notes).where(eq(notes.mark, mark)).orderBy(asc(notes.id))).map(
        row => row.id,
      ),
    deleteAll: async () => {
      await db.delete(notes)
    },
  }

  return {
    harness,
    cleanup: async () => {
      rbac.dispose()
      await pg.close()
    },
  }
}

runQueryIntegrationContractSuite({
  name: 'drizzle / trackedDb',
  makeHarness,
  test: { describe, it: test, expect, beforeEach, afterAll },
})
