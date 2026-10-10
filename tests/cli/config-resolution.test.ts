/// <reference types="bun-types" />
/**
 * How the CLI finds and validates kyroguard.config.*, driven through the real
 * CLI entry. A misconfigured project must fail with a message that names the
 * problem and the file, and must exit non-zero.
 */

import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SRC_TESTING, relativeImport, runCli } from './run.js'

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

const POLICIES = `export const resources = [
  {
    type: 'doc',
    policies: [{ name: 'docs.read', label: 'Read docs', dependsOn: [], scopeOptions: [] }],
  },
]
`

/** Paths inside a config resolve against the config's own directory, so each one gets its own policies.ts. */
async function project(files: Record<string, string> = {}): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'kyroguard-config-')))
  roots.push(dir)
  await writeFile(join(dir, 'policies.ts'), POLICIES, 'utf8')
  for (const [name, contents] of Object.entries(files)) {
    const target = join(dir, name)
    const targetDir = join(target, '..')
    await mkdir(targetDir, { recursive: true })
    await writeFile(join(targetDir, 'policies.ts'), POLICIES, 'utf8')
    await writeFile(target, contents.replace('%TESTING%', relativeImport(targetDir, SRC_TESTING)), 'utf8')
  }
  return dir
}

const VALID = `import { memoryAdapter } from '%TESTING%'

export default {
  adapter: async () => memoryAdapter(),
  domains: [{ name: 'admin', policies: './policies.ts' }],
  typegen: { output: './kyroguard.d.ts' },
}
`

describe('kyroguard CLI config resolution', () => {
  test('kyroguard.config.ts is discovered from the cwd with no --config', async () => {
    const dir = await project({ 'kyroguard.config.ts': VALID })
    const { exitCode, stderr } = await runCli(['sync'], dir)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  test('kyroguard.config.mjs also loads', async () => {
    const dir = await project({ 'kyroguard.config.mjs': VALID })
    const { exitCode, stderr } = await runCli(['sync'], dir)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  test('a relative --config path resolves against the cwd', async () => {
    const dir = await project({ 'config/custom.config.ts': VALID })
    const { exitCode, stderr } = await runCli(['sync', '--config', './config/custom.config.ts'], dir)

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
  })

  test('no config anywhere names the search location, the basenames and the way out', async () => {
    const dir = await project()
    const { exitCode, stderr } = await runCli(['sync'], dir)

    expect(stderr).toContain('[kyroguard]')
    expect(stderr).toContain('kyroguard.config.{ts,mts,mjs,js}')
    expect(stderr).toContain(dir)
    expect(stderr).toContain('kyroguard init')
    expect(stderr).toContain('--config')
    expect(exitCode).toBe(1)
  })

  test('an explicit --config path that does not exist names that path', async () => {
    const dir = await project()
    const { exitCode, stderr } = await runCli(['sync', '--config', './nope.config.ts'], dir)

    expect(stderr).toContain('Config file not found')
    expect(stderr).toContain('nope.config.ts')
    expect(exitCode).toBe(1)
  })

  test('a config with no "adapter" is rejected, naming the file', async () => {
    const dir = await project({
      'kyroguard.config.ts': `export default { domains: [{ name: 'admin', policies: './policies.ts' }] }\n`,
    })
    const { exitCode, stderr } = await runCli(['sync'], dir)

    expect(stderr).toContain('missing "adapter"')
    expect(stderr).toContain('kyroguard.config.ts')
    expect(exitCode).toBe(1)
  })

  test('an "adapter" that is not a function is rejected the same way', async () => {
    const dir = await project({
      'kyroguard.config.ts': `export default { adapter: {}, domains: [{ name: 'admin', policies: './policies.ts' }] }\n`,
    })
    const { exitCode, stderr } = await runCli(['sync'], dir)

    expect(stderr).toContain('missing "adapter"')
    expect(exitCode).toBe(1)
  })

  test('a config with no "domains" is rejected, naming the file', async () => {
    const dir = await project({
      'kyroguard.config.ts': `import { memoryAdapter } from '%TESTING%'

export default { adapter: async () => memoryAdapter() }
`,
    })
    const { exitCode, stderr } = await runCli(['sync'], dir)

    expect(stderr).toContain('missing "domains"')
    expect(stderr).toContain('kyroguard.config.ts')
    expect(exitCode).toBe(1)
  })

  test('a domain entry without "policies" is rejected, naming its index', async () => {
    const dir = await project({
      'kyroguard.config.ts': `import { memoryAdapter } from '%TESTING%'

export default {
  adapter: async () => memoryAdapter(),
  domains: [{ name: 'admin', policies: './policies.ts' }, { name: 'broken' }],
}
`,
    })
    const { exitCode, stderr } = await runCli(['sync'], dir)

    expect(stderr).toContain('domains[1]')
    expect(stderr).toContain('"policies"')
    expect(exitCode).toBe(1)
  })

  test('a config whose default export is not an object is rejected', async () => {
    const dir = await project({ 'kyroguard.config.ts': `export default 42\n` })
    const { exitCode, stderr } = await runCli(['sync'], dir)

    expect(stderr).toContain('must default-export a config object')
    expect(exitCode).toBe(1)
  })
})
