import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RbacConfig } from '../core/config.js'

const CONFIG_BASENAMES = ['rbac.config.ts', 'rbac.config.mts', 'rbac.config.mjs', 'rbac.config.js']

export async function loadConfig(explicitPath?: string): Promise<{ config: RbacConfig; path: string }> {
  const path = resolveConfigPath(explicitPath)
  const mod = await importModule(path)
  const loaded = (mod.default ?? mod) as unknown
  assertConfigShape(loaded, path)
  return { config: loaded, path }
}

/**
 * Loads a policy/groups module and returns the first defined export among
 * `candidates`, falling back to the default export.
 */
export async function loadModuleExport<T = unknown>(path: string, candidates: string[]): Promise<T> {
  const absolute = isAbsolute(path) ? path : resolve(path)
  if (!existsSync(absolute)) {
    throw new Error(`[rbac] Module not found: ${absolute}`)
  }
  const mod = await importModule(absolute)
  for (const name of candidates) {
    const value = mod[name]
    if (value !== undefined) return value as T
  }
  if (mod.default !== undefined) return mod.default as T
  throw new Error(
    `[rbac] ${path} exports none of: ${candidates.join(', ')} (and has no default export).`,
  )
}

/**
 * Bun executes TypeScript natively; under Node, jiti transpiles the user's
 * rbac.config.ts / policy files without requiring a build step.
 */
async function importModule(absolutePath: string): Promise<Record<string, unknown>> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
    return (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>
  }
  const { createJiti } = await import('jiti')
  const jiti = createJiti(import.meta.url, { interopDefault: true })
  return await jiti.import<Record<string, unknown>>(absolutePath)
}

function resolveConfigPath(explicitPath?: string): string {
  if (explicitPath) {
    const absolute = isAbsolute(explicitPath) ? explicitPath : resolve(process.cwd(), explicitPath)
    if (!existsSync(absolute)) {
      throw new Error(`[rbac] Config file not found: ${absolute}`)
    }
    return absolute
  }
  for (const basename of CONFIG_BASENAMES) {
    const candidate = join(process.cwd(), basename)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `[rbac] No rbac.config.{ts,mts,mjs,js} found in ${process.cwd()} — run \`rbac init\` or pass --config <path>.`,
  )
}

function assertConfigShape(config: unknown, path: string): asserts config is RbacConfig {
  if (typeof config !== 'object' || config === null) {
    throw new Error(
      `[rbac] ${path} must default-export a config object — use \`export default defineConfig({ ... })\`.`,
    )
  }
  const candidate = config as Record<string, unknown>
  if (typeof candidate.adapter !== 'function') {
    throw new Error(
      `[rbac] ${path} is missing "adapter" — expected a function returning a StorageAdapter, e.g. \`adapter: async () => drizzleAdapter(db)\`.`,
    )
  }
  if (!Array.isArray(candidate.portals)) {
    throw new Error(
      `[rbac] ${path} is missing "portals" — expected an array of { name?, policies, groups? }.`,
    )
  }
  candidate.portals.forEach((portal: unknown, index: number) => {
    const entry = portal as { policies?: unknown } | null
    if (typeof entry !== 'object' || entry === null || typeof entry.policies !== 'string') {
      throw new Error(
        `[rbac] ${path}: portals[${index}] is missing "policies" — expected a path to the module exporting your ResourceDefinition[].`,
      )
    }
  })
}
