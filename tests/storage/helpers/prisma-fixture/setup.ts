/// <reference types="bun-types" />
/**
 * Prisma test fixture bootstrap.
 *
 * Generates the client from ./schema.prisma into ./client (gitignored),
 * pushes the schema to a UNIQUE tmp sqlite file per fixture (the datasource
 * url comes from KYROGUARD_PRISMA_DB_URL, so parallel runs never collide), then
 * dynamically imports the generated client. The import is dynamic with a
 * computed specifier on purpose: the generated client does not exist until
 * `prisma generate` has run, and a static import would break `tsc --noEmit`
 * on a clean checkout.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  PrismaClientLike,
  PrismaModelDelegateLike,
} from '../../../../src/storage/prisma/index.js'

const fixtureDir = fileURLToPath(new URL('.', import.meta.url))
const schemaPath = join(fixtureDir, 'schema.prisma')
const packageRoot = fileURLToPath(new URL('../../../..', import.meta.url))

/** The generated client, as the tests use it (fixture-only surface). */
export type PrismaFixtureClient = PrismaClientLike & {
  /** Fixture-only resource model (extension tests). */
  post: PrismaModelDelegateLike
  $executeRawUnsafe(sql: string): Promise<unknown>
  $extends(extension: unknown): unknown
}

export interface PrismaFixture {
  client: PrismaFixtureClient
  dbUrl: string
  /** Disconnects the client and removes the tmp database files. */
  cleanup: () => Promise<void>
}

/** `prisma generate` output is shared and stable — run it once per process. */
let generated = false

export async function makePrismaFixture(tmpPrefix: string): Promise<PrismaFixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), tmpPrefix))
  const dbUrl = `file:${join(tmpDir, 'rbac.db')}`
  const env = { ...process.env, KYROGUARD_PRISMA_DB_URL: dbUrl }

  const runPrisma = (args: string[]): void => {
    const result = Bun.spawnSync(['bunx', 'prisma', ...args, '--schema', schemaPath], {
      cwd: packageRoot,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) {
      throw new Error(
        `[prisma-fixture] \`prisma ${args.join(' ')}\` failed:\n` +
          `${result.stdout.toString()}\n${result.stderr.toString()}`,
      )
    }
  }

  if (!generated) {
    runPrisma(['generate'])
    generated = true
  }
  runPrisma(['db', 'push', '--skip-generate'])

  const clientModule = (await import(join(fixtureDir, 'client', 'index.js'))) as {
    PrismaClient: new (options?: { datasourceUrl?: string }) => unknown
  }
  const client = new clientModule.PrismaClient({ datasourceUrl: dbUrl }) as PrismaFixtureClient

  return {
    client,
    dbUrl,
    cleanup: async () => {
      await client.$disconnect()
      rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}
