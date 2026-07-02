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

  const { resources: resourcesPath } = config.default ?? config
  if (!resourcesPath) {
    console.error('[rbac] rbac.config.ts must export default { resources: "./path/to/resources.ts" }')
    process.exit(1)
  }

  const resourcesModule = await import(pathToFileURL(resolve(process.cwd(), resourcesPath)).href)
  const resources = resourcesModule.resources ?? resourcesModule.default

  const { default: postgres } = await import('postgres')
  const { drizzle }           = await import('drizzle-orm/postgres-js')
  const { syncPolicies }      = await import('./sync.js')

  const client = postgres(url)
  const db     = drizzle(client)
  await syncPolicies(db, resources)
  await client.end()
  process.exit(0)
}

console.error(`[rbac] Unknown command: ${command ?? '(none)'}. Available: sync`)
process.exit(1)
