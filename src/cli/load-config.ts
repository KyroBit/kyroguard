import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DomainConfig, GuardConfig } from '../core/config.js'

/** A GuardConfig whose `domains` directory form has been expanded to entries. */
export type ResolvedGuardConfig = GuardConfig & { domains: DomainConfig[] }

const CONFIG_BASENAMES = ['kyroguard.config.ts', 'kyroguard.config.mts', 'kyroguard.config.mjs', 'kyroguard.config.js']

export async function loadConfig(explicitPath?: string): Promise<{ config: ResolvedGuardConfig; path: string }> {
  const path = resolveConfigPath(explicitPath)
  const mod = await importModule(path)
  const loaded = (mod.default ?? mod) as unknown
  assertConfigShape(loaded, path)
  const domains =
    typeof loaded.domains === 'string' ? expandDomainsDir(dirname(path), loaded.domains) : loaded.domains
  return { config: { ...loaded, domains }, path }
}

/** Returns the first defined export among `candidates`, falling back to the default export. */
export async function loadModuleExport<T = unknown>(path: string, candidates: string[]): Promise<T> {
  const absolute = isAbsolute(path) ? path : resolve(path)
  if (!existsSync(absolute)) {
    throw new Error(`[kyroguard] Module not found: ${absolute}`)
  }
  const mod = await importModule(absolute)
  for (const name of candidates) {
    const value = mod[name]
    if (value !== undefined) return value as T
  }
  if (mod.default !== undefined) return mod.default as T
  throw new Error(
    `[kyroguard] ${path} exports none of: ${candidates.join(', ')} (and has no default export).`,
  )
}

// Bun executes TypeScript natively; under Node, jiti transpiles the user's files.
async function importModule(absolutePath: string): Promise<Record<string, unknown>> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
    return (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>
  }
  const { createJiti } = await import('jiti')
  const jiti = createJiti(import.meta.url, { interopDefault: true })
  return await jiti.import<Record<string, unknown>>(absolutePath)
}

const MODULE_EXTS = ['.ts', '.mts', '.mjs', '.js']

function moduleName(file: string): string | null {
  if (file.endsWith('.d.ts')) return null
  for (const ext of MODULE_EXTS) {
    if (file.endsWith(ext)) return file.slice(0, -ext.length)
  }
  return null
}

function findModule(dir: string, base: string): string | null {
  for (const ext of MODULE_EXTS) {
    const candidate = join(dir, base + ext)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Convention scan for `domains: '<dir>'`. Two shapes:
 * - single domain: `<dir>/policies.ts` (+ optional `<dir>/groups.ts`) — the unnamed domain;
 * - multi-domain:  `<dir>/policies/<name>.ts` per domain, with `<dir>/groups/<name>.ts`
 *   attached when present. Adding a domain is adding a file.
 */
function expandDomainsDir(configDir: string, dir: string): DomainConfig[] {
  const root = isAbsolute(dir) ? dir : resolve(configDir, dir)
  if (!existsSync(root)) {
    throw new Error(`[kyroguard] domains directory not found: ${root}`)
  }
  const policiesDir = join(root, 'policies')
  const flat = findModule(root, 'policies')
  const hasPoliciesDir = existsSync(policiesDir) && statSync(policiesDir).isDirectory()

  if (hasPoliciesDir && flat) {
    throw new Error(
      `[kyroguard] ${root} has BOTH a policies/ directory and a flat policies module — keep one: flat for a single domain, policies/<name>.ts per domain.`,
    )
  }

  if (hasPoliciesDir) {
    const groupsDir = join(root, 'groups')
    const domains: DomainConfig[] = []
    for (const file of readdirSync(policiesDir).sort()) {
      const name = moduleName(file)
      if (name === null) continue
      const groups = findModule(groupsDir, name)
      domains.push({ name, policies: join(policiesDir, file), ...(groups ? { groups } : {}) })
    }
    if (domains.length === 0) {
      throw new Error(`[kyroguard] ${policiesDir} has no policy modules — add <domain>.ts per domain.`)
    }
    return domains
  }

  if (flat) {
    const groups = findModule(root, 'groups')
    return [{ name: '', policies: flat, ...(groups ? { groups } : {}) }]
  }

  throw new Error(
    `[kyroguard] ${root} has no policies — add policies.ts (single domain) or policies/<name>.ts (one per domain), or list domains explicitly.`,
  )
}

function resolveConfigPath(explicitPath?: string): string {
  if (explicitPath) {
    const absolute = isAbsolute(explicitPath) ? explicitPath : resolve(process.cwd(), explicitPath)
    if (!existsSync(absolute)) {
      throw new Error(`[kyroguard] Config file not found: ${absolute}`)
    }
    return absolute
  }
  for (const basename of CONFIG_BASENAMES) {
    const candidate = join(process.cwd(), basename)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `[kyroguard] No kyroguard.config.{ts,mts,mjs,js} found in ${process.cwd()} — run \`kyroguard init\` or pass --config <path>.`,
  )
}

function assertConfigShape(config: unknown, path: string): asserts config is GuardConfig {
  if (typeof config !== 'object' || config === null) {
    throw new Error(
      `[kyroguard] ${path} must default-export a config object — use \`export default defineConfig({ ... })\`.`,
    )
  }
  const candidate = config as Record<string, unknown>
  if (typeof candidate.adapter !== 'function') {
    throw new Error(
      `[kyroguard] ${path} is missing "adapter" — expected a function returning a StorageAdapter, e.g. \`adapter: async () => drizzleAdapter(db)\`.`,
    )
  }
  if (typeof candidate.domains === 'string') {
    if (candidate.domains === '') {
      throw new Error(`[kyroguard] ${path}: "domains" must not be an empty string — pass the directory holding your *.policies.ts files.`)
    }
    return
  }
  if (!Array.isArray(candidate.domains)) {
    throw new Error(
      `[kyroguard] ${path} is missing "domains" — expected an array of { name?, policies, groups? } or a directory to scan.`,
    )
  }
  candidate.domains.forEach((domain: unknown, index: number) => {
    const entry = domain as { policies?: unknown } | null
    if (typeof entry !== 'object' || entry === null || typeof entry.policies !== 'string') {
      throw new Error(
        `[kyroguard] ${path}: domains[${index}] is missing "policies" — expected a path to the module exporting your ResourceDefinition[].`,
      )
    }
  })
}
