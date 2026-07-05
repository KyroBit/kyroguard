#!/usr/bin/env node
/**
 * rbac CLI. Never imports a DB driver or ORM — the user's rbac.config.ts
 * owns those imports via its lazy adapter factory.
 */
import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { loadConfig } from './load-config.js'
import { run as runInit } from './commands/init.js'
import { run as runSync } from './commands/sync.js'
import { run as runGenerate } from './commands/generate.js'
import { run as runStatus } from './commands/status.js'

const USAGE = `rbac — policies-as-code sync, typegen and scaffolding for @kyrobit/rbac

Usage
  rbac <command> [options]

Commands
  init      Scaffold rbac.config.ts, starter policies/groups and wiring
  sync      Push policies + groups to storage, then write rbac.d.ts
  generate  Write rbac.d.ts from your policy files only (no database)
  status    Show adapter id, capabilities and stored policy/group counts

Options
  --config <path>  Path to rbac.config.{ts,mts,mjs,js} (default: search cwd)
  --yes            Accept defaults and skip prompts (init)
  --help           Show this help
  --version        Print the CLI version
`

async function main(): Promise<void> {
  loadDotEnv()

  let values: { config?: string; yes?: boolean; help?: boolean; version?: boolean }
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: {
        config: { type: 'string' },
        yes: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    }))
  } catch (error) {
    console.error(`[rbac] ${error instanceof Error ? error.message : String(error)}`)
    console.error(USAGE)
    process.exitCode = 1
    return
  }

  if (values.version) {
    console.log(readVersion())
    return
  }

  const command = positionals[0]
  if (values.help || command === undefined) {
    console.log(USAGE)
    if (command === undefined && !values.help) process.exitCode = 1
    return
  }

  switch (command) {
    case 'init':
      await runInit({ cwd: process.cwd(), yes: values.yes === true })
      break
    case 'sync': {
      const { config, path } = await loadConfig(values.config)
      await runSync(config, dirname(path))
      break
    }
    case 'generate': {
      const { config, path } = await loadConfig(values.config)
      await runGenerate(config, dirname(path))
      break
    }
    case 'status': {
      const { config } = await loadConfig(values.config)
      await runStatus(config)
      break
    }
    default:
      console.error(`[rbac] Unknown command "${command}".`)
      console.error(USAGE)
      process.exitCode = 1
  }
}

function loadDotEnv(): void {
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(join(process.cwd(), '.env'))
    }
  } catch {
    // No .env file — fine.
  }
}

function readVersion(): string {
  const require = createRequire(import.meta.url)
  const pkg = require('../../package.json') as { version?: string }
  return pkg.version ?? 'unknown'
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message.startsWith('[rbac]') ? message : `[rbac] ${message}`)
  process.exitCode = 1
})
