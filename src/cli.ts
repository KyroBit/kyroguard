#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resolve }       from 'node:path'

try { process.loadEnvFile(resolve(process.cwd(), '.env')) } catch {}

const [,, command] = process.argv

if (command === 'sync') {
  const configPath = resolve(process.cwd(), 'rbac.config.ts')

  let config: any
  try {
    config = await import(pathToFileURL(configPath).href)
  } catch {
    console.error('[rbac] Could not load rbac.config.ts — make sure it exists in your project root.')
    process.exit(1)
  }

  const { db, resources } = config.default ?? config

  if (!db || !resources) {
    console.error('[rbac] rbac.config.ts must export { db, resources }')
    process.exit(1)
  }

  const { syncPolicies } = await import('./sync.js')
  await syncPolicies(db, resources)
  process.exit(0)
}

console.error(`[rbac] Unknown command: ${command ?? '(none)'}. Available: sync`)
process.exit(1)
