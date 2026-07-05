import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../../src/cli/load-config.js'
import { run as runSync } from '../../src/cli/commands/sync.js'
import type { StorageAdapter } from '../../src/storage/contract.js'

/**
 * Full fixture project driven through the real CLI path:
 * loadConfig(rbac.config.ts) → runSync(). The config's lazy adapter factory
 * returns a module-level singleton (rig.ts) wrapping memoryAdapter(), so the
 * test can observe exactly what sync wrote across the CLI import boundary —
 * Bun's module cache makes the fixture's `import './rig.ts'` and the test's
 * dynamic import of the same file resolve to ONE module instance.
 */

const SRC_TESTING = join(import.meta.dir, '..', '..', 'src', 'testing', 'index.ts')

interface Rig {
  adapter: StorageAdapter
  calls: string[]
}

let fixture: string
let rig: Rig
let syncLogs: string[]

function relativeImport(fromDir: string, toFile: string): string {
  const spec = relative(fromDir, toFile).split('\\').join('/')
  return spec.startsWith('.') ? spec : `./${spec}`
}

async function writeFixtureProject(): Promise<string> {
  // realpath: the relative import written into rig.ts must be computed from
  // the RESOLVED path (macOS tmpdir sits behind the /var → /private/var symlink).
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rbac-sync-')))

  // Module-level singleton: same instance for the config's adapter factory
  // and for the test's assertions. Spies record call order (S17: ensureSchema
  // must run before any write).
  await writeFile(
    join(dir, 'rig.ts'),
    `import { memoryAdapter } from '${relativeImport(dir, SRC_TESTING)}'

const inner = memoryAdapter()

export const calls: string[] = []

export const adapter = {
  ...inner,
  async ensureSchema() {
    calls.push('ensureSchema')
    await inner.ensureSchema?.()
  },
  async upsertPolicies(rows: Parameters<typeof inner.upsertPolicies>[0]) {
    calls.push('upsertPolicies')
    return inner.upsertPolicies(rows)
  },
  async upsertGroup(group: Parameters<typeof inner.upsertGroup>[0]) {
    calls.push('upsertGroup')
    return inner.upsertGroup(group)
  },
  async setGroupPolicies(name: string, entries: Parameters<typeof inner.setGroupPolicies>[1]) {
    calls.push('setGroupPolicies')
    return inner.setGroupPolicies(name, entries)
  },
  async close() {
    calls.push('close')
  },
}
`,
    'utf8',
  )

  // Two policies; docs.write depends on docs.read. Plain objects satisfy the
  // structural Policy shape sync consumes (name/label/dependsOn/scopeOptions).
  await writeFile(
    join(dir, 'policies.ts'),
    `export const resources = [
  {
    type: 'doc',
    policies: [
      { name: 'docs.read', label: 'Read docs', dependsOn: [], scopeOptions: [] },
      { name: 'docs.write', label: 'Write docs', dependsOn: ['docs.read'], scopeOptions: [] },
    ],
  },
]
`,
    'utf8',
  )

  await writeFile(
    join(dir, 'groups.ts'),
    `export const groups = {
  admin: { label: 'Administrator', policies: 'all' },
  editor: { label: 'Editor', policies: { 'docs.write': null } },
}
`,
    'utf8',
  )

  await writeFile(
    join(dir, 'rbac.config.ts'),
    `import { adapter } from './rig.ts'

export default {
  // Lazy factory, as the real config template ships it.
  adapter: async () => adapter,
  domains: [{ name: 'admin', policies: './policies.ts', groups: './groups.ts' }],
  typegen: { output: './rbac.d.ts' },
}
`,
    'utf8',
  )

  return dir
}

beforeAll(async () => {
  fixture = await writeFixtureProject()

  const originalLog = console.log
  const previousExitCode = process.exitCode
  syncLogs = []
  console.log = (...args: unknown[]) => {
    syncLogs.push(args.map(String).join(' '))
  }
  try {
    const { config, path } = await loadConfig(join(fixture, 'rbac.config.ts'))
    await runSync(config, dirname(path))
  } finally {
    console.log = originalLog
  }

  // sync reports failures via process.exitCode, not throws — a poisoned
  // exit code would both hide a failure and fail the whole bun test run.
  expect(process.exitCode).toBe(previousExitCode as never)

  rig = (await import(pathToFileURL(join(fixture, 'rig.ts')).href)) as Rig
})

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

describe('rbac sync (full fixture project)', () => {
  test('adapter factory resolved the singleton and sync completed without error', () => {
    expect(rig.calls.length).toBeGreaterThan(0)
    expect(syncLogs.some(line => line.includes('sync failed'))).toBe(false)
    expect(syncLogs.some(line => line.includes('Synced 2 policies'))).toBe(true)
  })

  test('ensureSchema ran first, before any write (S17)', () => {
    expect(rig.calls[0]).toBe('ensureSchema')
    expect(rig.calls.filter(call => call === 'ensureSchema')).toHaveLength(1)
    const firstWrite = rig.calls.findIndex(call => call !== 'ensureSchema')
    expect(firstWrite).toBeGreaterThan(0)
  })

  test('policies were upserted domain-qualified with qualified dependencies', async () => {
    const records = await rig.adapter.listPolicies()
    const byName = new Map(records.map(record => [record.name, record]))

    expect([...byName.keys()].toSorted()).toEqual(['admin.docs.read', 'admin.docs.write'])
    // PolicyRecord exposes id/name/domain/scopeOptions/dependsOn — label is write-only here.
    expect(byName.get('admin.docs.read')?.domain).toBe('admin')
    expect(byName.get('admin.docs.write')?.domain).toBe('admin')
    // dependsOn is qualified alongside the names themselves.
    expect(byName.get('admin.docs.write')?.dependsOn).toEqual(['admin.docs.read'])
    expect(byName.get('admin.docs.read')?.dependsOn).toEqual([])
  })

  test('groups were seeded: all-policies group and scoped group, names qualified', async () => {
    const groups = await rig.adapter.listGroups()
    const names = groups.map(group => group.name).toSorted()
    expect(names).toEqual(['admin', 'editor'])

    const admin = groups.find(group => group.name === 'admin')
    expect(admin?.label).toBe('Administrator')
    expect(admin?.isSystem).toBe(false)

    const adminPolicies = await rig.adapter.getGroupPolicies('admin')
    expect(adminPolicies.map(entry => entry.policyName).toSorted()).toEqual([
      'admin.docs.read',
      'admin.docs.write',
    ])
    expect(adminPolicies.every(entry => entry.scope === null)).toBe(true)

    // editor was seeded with only docs.write; docs.read arrives via the
    // POST-seed dependency back-fill (regression: replace-all seeding used
    // to wipe the dependencies syncPolicies had just filled).
    const editorPolicies = await rig.adapter.getGroupPolicies('editor')
    expect(editorPolicies.map(entry => entry.policyName).toSorted()).toEqual([
      'admin.docs.read',
      'admin.docs.write',
    ])
    expect(editorPolicies.every(entry => entry.scope === null)).toBe(true)

    expect(syncLogs.some(line => line.includes('Seeded 2 groups'))).toBe(true)
    expect(
      syncLogs.some(line => line.includes('Filled 1 missing deps for group editor')),
    ).toBe(true)
  })

  test('group writes happened through upsertGroup + setGroupPolicies, after ensureSchema', () => {
    expect(rig.calls.filter(call => call === 'upsertGroup')).toHaveLength(2)
    expect(rig.calls.filter(call => call === 'setGroupPolicies')).toHaveLength(2)
    expect(rig.calls.indexOf('upsertGroup')).toBeGreaterThan(rig.calls.indexOf('ensureSchema'))
    expect(rig.calls.indexOf('upsertPolicies')).toBeGreaterThan(rig.calls.indexOf('ensureSchema'))
  })

  test('rbac.d.ts was written with the domain union and unqualified policy names', async () => {
    const declaration = await readFile(join(fixture, 'rbac.d.ts'), 'utf8')
    expect(declaration).toContain("declare module '@kyrobit/rbac'")
    expect(declaration).toContain('Domain: "admin"')
    expect(declaration).toContain('PolicyName: "docs.read" | "docs.write"')
    expect(declaration).toContain('"admin": "docs.read" | "docs.write"')
    expect(syncLogs.some(line => line.includes('Wrote') && line.includes('rbac.d.ts'))).toBe(true)
  })

  test('adapter.close was called (exactly once, last)', () => {
    expect(rig.calls.filter(call => call === 'close')).toHaveLength(1)
    expect(rig.calls.at(-1)).toBe('close')
  })
})
