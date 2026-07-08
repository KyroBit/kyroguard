/// <reference types="bun-types" />
/**
 * The CLI process must terminate. Regression for the release blocker where
 * `kyroguard sync` printed its success lines and then hung forever: the
 * config module (user code) held a live handle the CLI could not reach, so
 * the event loop never drained and `execSync('kyroguard sync')` in seed
 * scripts blocked indefinitely.
 *
 * The fixture reproduces that faithfully — its kyroguard.config.ts starts a
 * setInterval at module scope (standing in for the shared db client a real
 * config imports) — and the real CLI entry is spawned as a child process,
 * exactly like a seed script shelling out. The assertions are on the child's
 * exit itself, within a hard deadline.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const CLI = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts')
const DIST_CLI = join(import.meta.dir, '..', '..', 'dist', 'cli', 'index.js')
const SRC_TESTING = join(import.meta.dir, '..', '..', 'src', 'testing', 'index.ts')

/** Generous for CI; the child normally exits in well under a second. */
const EXIT_DEADLINE_MS = 20_000

let fixture: string

function relativeImport(fromDir: string, toFile: string): string {
  const spec = relative(fromDir, toFile).split('\\').join('/')
  return spec.startsWith('.') ? spec : `./${spec}`
}

async function runCli(
  args: string[],
  cwd: string,
  entry: { runtime: string; cli: string } = { runtime: process.execPath, cli: CLI },
): Promise<{ exitCode: number | 'timeout'; stdout: string; stderr: string }> {
  const child = Bun.spawn([entry.runtime, entry.cli, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const exitCode = await Promise.race([
    child.exited,
    new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), EXIT_DEADLINE_MS)
    }),
  ])
  clearTimeout(timer)
  if (exitCode === 'timeout') child.kill()
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

beforeAll(async () => {
  // realpath: macOS tmpdir sits behind the /var → /private/var symlink and
  // the relative import written into the fixture must match the real cwd.
  fixture = await realpath(await mkdtemp(join(tmpdir(), 'kyroguard-exit-')))

  await writeFile(
    join(fixture, 'policies.ts'),
    `export const resources = [
  {
    type: 'doc',
    policies: [{ name: 'docs.read', label: 'Read docs', dependsOn: [], scopeOptions: [] }],
  },
]
`,
    'utf8',
  )

  await writeFile(
    join(fixture, 'kyroguard.config.ts'),
    `import { memoryAdapter } from '${relativeImport(fixture, SRC_TESTING)}'

// The handle the CLI cannot know about: real configs import the app's shared
// db module, whose driver keeps sockets open. Without an explicit exit this
// keeps the child alive forever after sync's last log line.
setInterval(() => {}, 60_000)

export default {
  adapter: async () => memoryAdapter(),
  domains: [{ name: 'admin', policies: './policies.ts' }],
  typegen: { output: './kyroguard.d.ts' },
}
`,
    'utf8',
  )

  await writeFile(
    join(fixture, 'kyroguard.broken.config.ts'),
    `setInterval(() => {}, 60_000)

export default {
  adapter: async () => {
    throw new Error('factory exploded')
  },
  domains: [{ name: 'admin', policies: './policies.ts' }],
}
`,
    'utf8',
  )

  // A wedged driver: close() never settles. The CLI bounds the close with a
  // deadline, so even this must not keep the process alive.
  await writeFile(
    join(fixture, 'kyroguard.wedged.config.ts'),
    `import { memoryAdapter } from '${relativeImport(fixture, SRC_TESTING)}'

setInterval(() => {}, 60_000)

export default {
  adapter: async () => ({ ...memoryAdapter(), close: () => new Promise<void>(() => {}) }),
  domains: [{ name: 'admin', policies: './policies.ts' }],
  typegen: { output: './kyroguard.d.ts' },
}
`,
    'utf8',
  )
})

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

describe('kyroguard CLI process termination', () => {
  test(
    'sync exits 0 even when the config module holds a live handle',
    async () => {
      const { exitCode, stdout, stderr } = await runCli(['sync'], fixture)
      expect(stderr).toBe('')
      expect(stdout).toContain('Synced 1 policies')
      expect(stdout).toContain('kyroguard.d.ts')
      expect(exitCode).toBe(0)
    },
    EXIT_DEADLINE_MS + 5_000,
  )

  test(
    'a failing sync still exits, with code 1',
    async () => {
      const { exitCode, stderr } = await runCli(
        ['sync', '--config', './kyroguard.broken.config.ts'],
        fixture,
      )
      expect(stderr).toContain('sync failed')
      expect(exitCode).toBe(1)
    },
    EXIT_DEADLINE_MS + 5_000,
  )

  test(
    'status exits 0 even when the config module holds a live handle',
    async () => {
      const { exitCode, stdout } = await runCli(['status'], fixture)
      expect(stdout).toContain('adapter:')
      expect(exitCode).toBe(0)
    },
    EXIT_DEADLINE_MS + 5_000,
  )

  test(
    'sync exits 0 even when the adapter close() never settles',
    async () => {
      const { exitCode, stdout, stderr } = await runCli(
        ['sync', '--config', './kyroguard.wedged.config.ts'],
        fixture,
      )
      expect(stdout).toContain('Synced 1 policies')
      expect(stderr).toContain('close() did not finish')
      expect(exitCode).toBe(0)
    },
    EXIT_DEADLINE_MS + 5_000,
  )

  // The published bin is dist/cli/index.js under Node (jiti transpiles the
  // user's TS config) — a different runtime and event loop than bun + src.
  // Skipped on a clean checkout; `bun run build` first to exercise it.
  const distBuilt = existsSync(DIST_CLI)
  test.skipIf(!distBuilt)(
    'sync under node + dist + jiti exits 0 with a live handle in the config',
    async () => {
      const { exitCode, stdout, stderr } = await runCli(['sync'], fixture, {
        runtime: 'node',
        cli: DIST_CLI,
      })
      expect(stderr).toBe('')
      expect(stdout).toContain('Synced 1 policies')
      expect(exitCode).toBe(0)
    },
    EXIT_DEADLINE_MS + 5_000,
  )
})
