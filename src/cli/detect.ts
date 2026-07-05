import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DetectedStack {
  framework: 'fastify' | 'express' | null
  orm: 'drizzle' | 'prisma' | 'mongoose' | null
  dialect: 'pg' | 'mysql' | 'sqlite' | null
}

export function detectStack(cwd: string): DetectedStack {
  const deps = readDependencies(cwd)

  const framework = deps.has('fastify') ? 'fastify' : deps.has('express') ? 'express' : null
  // Precedence: drizzle > prisma > mongoose. drizzle-orm in a project's deps
  // almost always means drizzle IS the app's ORM (prisma often lingers as a
  // tooling/transitive dep during migrations), and prisma likewise outranks
  // mongoose.
  const orm: DetectedStack['orm'] = deps.has('drizzle-orm')
    ? 'drizzle'
    : deps.has('@prisma/client') || deps.has('prisma')
      ? 'prisma'
      : deps.has('mongoose')
        ? 'mongoose'
        : null
  const dialect =
    orm === 'drizzle'
      ? detectDialect(cwd, deps)
      : orm === 'prisma'
        ? detectPrismaDialect(cwd)
        : null

  return { framework, orm, dialect }
}

function readDependencies(cwd: string): Set<string> {
  try {
    const raw = readFileSync(join(cwd, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ])
  } catch {
    return new Set()
  }
}

const DRIZZLE_CONFIGS = [
  'drizzle.config.ts',
  'drizzle.config.mts',
  'drizzle.config.js',
  'drizzle.config.mjs',
  'drizzle.config.cjs',
]

function detectDialect(cwd: string, deps: Set<string>): DetectedStack['dialect'] {
  for (const basename of DRIZZLE_CONFIGS) {
    const path = join(cwd, basename)
    if (!existsSync(path)) continue
    try {
      const source = readFileSync(path, 'utf8')
      const match = /dialect\s*:\s*['"`]([a-z]+)['"`]/.exec(source)
      const declared = match?.[1]
      if (declared === 'postgresql') return 'pg'
      if (declared === 'mysql') return 'mysql'
      if (declared === 'sqlite' || declared === 'turso') return 'sqlite'
    } catch {
      // Unreadable config — fall through to driver detection.
    }
  }

  if (deps.has('pg') || deps.has('postgres')) return 'pg'
  if (deps.has('mysql2')) return 'mysql'
  if (deps.has('better-sqlite3') || deps.has('libsql') || deps.has('@libsql/client')) return 'sqlite'
  return null
}

const PRISMA_SCHEMAS = [join('prisma', 'schema.prisma'), 'schema.prisma']

function detectPrismaDialect(cwd: string): DetectedStack['dialect'] {
  for (const relative of PRISMA_SCHEMAS) {
    const path = join(cwd, relative)
    if (!existsSync(path)) continue
    try {
      const source = readFileSync(path, 'utf8')
      // Matches only the datasource provider — the generator block's
      // provider ("prisma-client-js") never matches these alternatives.
      const match = /provider\s*=\s*["'](postgresql|mysql|sqlite)["']/.exec(source)
      const declared = match?.[1]
      if (declared === 'postgresql') return 'pg'
      if (declared === 'mysql') return 'mysql'
      if (declared === 'sqlite') return 'sqlite'
    } catch {
      // Unreadable schema — try the next candidate.
    }
  }
  return null
}
