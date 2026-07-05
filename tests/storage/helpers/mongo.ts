/// <reference types="bun-types" />
/**
 * Shared mongodb-memory-server harness for the Mongoose adapter/plugin tests.
 *
 * ONE MongoMemoryServer is started per test file (module state is shared
 * within a file's run; stopMongo() in afterAll resets it so the next file
 * boots its own). Every makeAdapter()/makeConnection() call gets a fresh
 * mongoose Connection against a UNIQUE database name, and ensureSchema() is
 * awaited before the adapter is handed out so the unique indexes S10/S13
 * depend on exist before any case runs (syncIndexes has completed).
 *
 * The first run downloads the mongod binary — that can take up to ~120s and
 * happens at module load (top-level await), outside any per-test timeout. If
 * the download/boot fails, mongoAvailable() returns false and callers skip.
 */

import mongoose from 'mongoose'

import { MongoMemoryServer } from 'mongodb-memory-server'

import { mongooseAdapter } from '../../../src/storage/mongoose/index.js'
import type { Connection } from 'mongoose'
import type { StorageAdapter } from '../../../src/storage/contract.js'

let server: MongoMemoryServer | null = null
let startFailed = false
let dbCounter = 0
const openConnections = new Set<Connection>()

/** Boots the shared server (idempotent). Returns false if mongod cannot run here. */
export async function mongoAvailable(): Promise<boolean> {
  if (server) return true
  if (startFailed) return false
  try {
    server = await MongoMemoryServer.create()
    return true
  } catch (error) {
    startFailed = true
    // Deliberately loud: a skip must be diagnosable, never silent.
    console.warn('[tests/storage/helpers/mongo] mongod unavailable, skipping:', error)
    return false
  }
}

/** A fresh connection to a unique database on the shared server. */
export async function makeConnection(): Promise<Connection> {
  if (!server) throw new Error('[mongo helper] call mongoAvailable() first')
  dbCounter += 1
  const dbName = `rbac_test_${dbCounter}`
  const connection = mongoose.createConnection(server.getUri(), { dbName })
  await connection.asPromise()
  openConnections.add(connection)
  return connection
}

/**
 * Contract-suite factory: fresh connection + unique db + adapter with
 * ensureSchema() already completed (unique indexes in place).
 */
export async function makeAdapter(): Promise<{
  adapter: StorageAdapter
  cleanup: () => Promise<void>
}> {
  const connection = await makeConnection()
  const adapter = mongooseAdapter(connection)
  await adapter.ensureSchema?.()
  return {
    adapter,
    cleanup: async () => {
      await closeConnection(connection)
    },
  }
}

export async function closeConnection(connection: Connection): Promise<void> {
  openConnections.delete(connection)
  try {
    await connection.close()
  } catch {
    // already closed — fine during teardown
  }
}

/** afterAll hook: closes every connection this file opened and stops mongod. */
export async function stopMongo(): Promise<void> {
  for (const connection of [...openConnections]) await closeConnection(connection)
  if (server) {
    await server.stop()
    server = null
  }
  // Allow the next test file in the same process to boot its own server.
  startFailed = false
}
