import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/cli/load-config.js'

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

/** Fresh fixture dir per case — Bun caches ES modules by path, so a config
 * file is never rewritten with different content under the same name. */
async function fixtureDir(): Promise<string> {
  // realpath: macOS tmpdir lives behind the /var → /private/var symlink and
  // loadConfig compares paths derived from process.cwd() (already resolved).
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rbac-loadconfig-')))
  roots.push(root)
  return root
}

async function writeConfig(dir: string, basename: string, body: string): Promise<string> {
  const path = join(dir, basename)
  await writeFile(path, body, 'utf8')
  return path
}

const VALID_TS_CONFIG = `
const config = {
  adapter: async () => ({ id: 'stub' }),
  portals: [
    { name: 'admin', policies: './src/rbac/policies.ts', groups: './src/rbac/groups.ts' },
  ],
  typegen: { output: './types/rbac.d.ts' },
}
export default config
`

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd()
  process.chdir(dir)
  try {
    return await fn()
  } finally {
    process.chdir(previous)
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    return error as Error
  }
  throw new Error('expected promise to reject')
}

describe('loadConfig', () => {
  test('valid rbac.config.ts loads under Bun via explicit path', async () => {
    const dir = await fixtureDir()
    const path = await writeConfig(dir, 'rbac.config.ts', VALID_TS_CONFIG)

    const result = await loadConfig(path)
    expect(result.path).toBe(path)
    expect(typeof result.config.adapter).toBe('function')
    expect(result.config.portals).toHaveLength(1)
    expect(result.config.portals[0]?.name).toBe('admin')
    expect(result.config.portals[0]?.policies).toBe('./src/rbac/policies.ts')
    expect(result.config.typegen?.output).toBe('./types/rbac.d.ts')
  })

  test('rbac.config.ts is discovered from the cwd without --config', async () => {
    const dir = await fixtureDir()
    const path = await writeConfig(dir, 'rbac.config.ts', VALID_TS_CONFIG)

    const result = await withCwd(dir, () => loadConfig())
    expect(result.path).toBe(path)
    expect(result.config.portals[0]?.name).toBe('admin')
  })

  test('rbac.config.mjs also loads', async () => {
    const dir = await fixtureDir()
    const path = await writeConfig(
      dir,
      'rbac.config.mjs',
      `export default {
        adapter: async () => ({ id: 'stub-mjs' }),
        portals: [{ policies: './policies.mjs' }],
      }
      `,
    )

    const result = await loadConfig(path)
    expect(result.path).toBe(path)
    expect(result.config.portals[0]?.policies).toBe('./policies.mjs')
    // Portal-less setup: name omitted is allowed.
    expect(result.config.portals[0]?.name).toBeUndefined()

    // And it is discovered by the cwd search too (search order includes .mjs).
    const searched = await withCwd(dir, () => loadConfig())
    expect(searched.path).toBe(path)
  })

  test('no config anywhere → readable error naming the search location and basenames', async () => {
    const dir = await fixtureDir()
    const error = await withCwd(dir, () => rejectionOf(loadConfig()))

    expect(error.message).toContain('[rbac]')
    // Names all searched basenames…
    expect(error.message).toContain('rbac.config.{ts,mts,mjs,js}')
    // …and where it looked…
    expect(error.message).toContain(dir)
    // …and how to fix it.
    expect(error.message).toContain('rbac init')
    expect(error.message).toContain('--config')
  })

  test('explicit --config path that does not exist → error naming that path', async () => {
    const dir = await fixtureDir()
    const missing = join(dir, 'nope', 'rbac.config.ts')
    const error = await rejectionOf(loadConfig(missing))
    expect(error.message).toContain('Config file not found')
    expect(error.message).toContain(missing)
  })

  test('relative explicit path resolves against the cwd', async () => {
    const dir = await fixtureDir()
    await mkdir(join(dir, 'config'), { recursive: true })
    const path = await writeConfig(join(dir, 'config'), 'rbac.config.ts', VALID_TS_CONFIG)

    const result = await withCwd(dir, () => loadConfig(join('config', 'rbac.config.ts')))
    expect(result.path).toBe(path)
  })

  test('config missing "adapter" → specific validation error', async () => {
    const dir = await fixtureDir()
    const path = await writeConfig(
      dir,
      'rbac.config.ts',
      `export default { portals: [{ policies: './p.ts' }] }`,
    )
    const error = await rejectionOf(loadConfig(path))
    expect(error.message).toContain('missing "adapter"')
    expect(error.message).toContain(path)
  })

  test('adapter present but not a function → adapter validation error', async () => {
    const dir = await fixtureDir()
    const path = await writeConfig(
      dir,
      'rbac.config.ts',
      `export default { adapter: { id: 'not-a-factory' }, portals: [] }`,
    )
    const error = await rejectionOf(loadConfig(path))
    expect(error.message).toContain('missing "adapter"')
  })

  test('config missing "portals" → specific validation error', async () => {
    const dir = await fixtureDir()
    const path = await writeConfig(
      dir,
      'rbac.config.ts',
      `export default { adapter: async () => ({ id: 'stub' }) }`,
    )
    const error = await rejectionOf(loadConfig(path))
    expect(error.message).toContain('missing "portals"')
    expect(error.message).toContain(path)
  })

  test('portal entry without "policies" → error naming the bad index', async () => {
    const dir = await fixtureDir()
    const path = await writeConfig(
      dir,
      'rbac.config.ts',
      `export default {
        adapter: async () => ({ id: 'stub' }),
        portals: [
          { name: 'admin', policies: './p.ts' },
          { name: 'customer' },
        ],
      }`,
    )
    const error = await rejectionOf(loadConfig(path))
    expect(error.message).toContain('portals[1]')
    expect(error.message).toContain('"policies"')
  })

  test('non-object default export → must-default-export error', async () => {
    const dir = await fixtureDir()
    const path = await writeConfig(dir, 'rbac.config.ts', `export default 42`)
    const error = await rejectionOf(loadConfig(path))
    expect(error.message).toContain('must default-export a config object')
    expect(error.message).toContain('defineConfig')
  })
})
