#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resolve }       from 'node:path'

try { process.loadEnvFile(resolve(process.cwd(), '.env')) } catch {}

const [,, command] = process.argv

if (command === 'sync') {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('[rbac] DATABASE_URL is not set.')
    process.exit(1)
  }

  const configPath = resolve(process.cwd(), 'rbac.config.ts')
  let config: any
  try {
    config = await import(pathToFileURL(configPath).href)
  } catch {
    console.error('[rbac] Could not load rbac.config.ts — make sure it exists in your project root.')
    process.exit(1)
  }

  const { policies: policiesPath } = config.default ?? config
  if (!policiesPath) {
    console.error('[rbac] rbac.config.ts must export default { policies: "./path/to/policies.ts" }')
    process.exit(1)
  }

  const policiesModule = await import(pathToFileURL(resolve(process.cwd(), policiesPath)).href)
  const resources = policiesModule.policies ?? policiesModule.resources ?? policiesModule.default

  const { default: postgres }      = await import('postgres')
  const { drizzle }                = await import('drizzle-orm/postgres-js')
  const { createDrizzleAdapter }   = await import('./drizzle-adapter.js')
  const { syncPolicies }           = await import('./sync.js')

  const client  = postgres(url)
  const adapter = createDrizzleAdapter(drizzle(client))
  await syncPolicies(adapter, resources)
  await client.end()
  process.exit(0)
}

console.error(`[rbac] Unknown command: ${command ?? '(none)'}. Available: sync`)
process.exit(1)
