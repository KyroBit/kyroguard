import { describe, test, expect, afterAll } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run as runInit } from '../../src/cli/commands/init.js'

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

async function projectDir(
  dependencies: Record<string, string>,
  devDependencies?: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kyroguard-init-'))
  roots.push(root)
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-app', version: '0.0.0', dependencies, devDependencies }, null, 2),
    'utf8',
  )
  return root
}

function prismaSchemaSource(provider: string): string {
  return `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "${provider}"
  url      = env("DATABASE_URL")
}
`
}

/** init prints its plan/next-steps; keep test output clean and capture it. */
async function runInitQuiet(cwd: string): Promise<string[]> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    await runInit({ cwd, yes: true })
  } finally {
    console.log = original
  }
  return lines
}

const KYROGUARD_TABLES = [
  'kyroguard_policies',
  'kyroguard_policy_groups',
  'kyroguard_policy_group_policies',
  'kyroguard_user_policy_groups',
  'kyroguard_user_policies',
  'kyroguard_resource_owners',
]

const PRISMA_MODELS = [
  'KyroguardPolicy',
  'KyroguardPolicyGroup',
  'KyroguardPolicyGroupPolicy',
  'KyroguardUserPolicyGroup',
  'KyroguardUserPolicy',
  'KyroguardResourceOwner',
]

describe('kyroguard init --yes', () => {
  test('fastify + drizzle-orm + pg project gets config, policies, groups, domains and the pg schema', async () => {
    const cwd = await projectDir({ fastify: '^5.0.0', 'drizzle-orm': '^0.36.0', pg: '^8.13.0' })
    const lines = await runInitQuiet(cwd)

    // Detection is announced.
    expect(lines.join('\n')).toContain('framework: fastify')
    expect(lines.join('\n')).toContain('orm:       drizzle')
    expect(lines.join('\n')).toContain('dialect:   pg')

    // All five files land.
    const config = await readFile(join(cwd, 'kyroguard.config.ts'), 'utf8')
    const policies = await readFile(join(cwd, 'src', 'kyroguard', 'policies', 'admin.ts'), 'utf8')
    const groups = await readFile(join(cwd, 'src', 'kyroguard', 'groups', 'admin.ts'), 'utf8')
    const domains = await readFile(join(cwd, 'src', 'kyroguard', 'domains.ts'), 'utf8')
    const schema = await readFile(join(cwd, 'src', 'db', 'kyroguard-schema.ts'), 'utf8')

    // Drizzle config variant with substitutions applied (no leftover markers).
    expect(config).toContain('drizzleAdapter')
    expect(config).toContain("domains: './src/kyroguard'")
    expect(config).not.toContain('{{DOMAIN}}')
    expect(config).not.toContain('{{DIALECT}}')

    expect(policies).toContain('resources')
    expect(policies).toContain('new Policy(')
    expect(groups).toContain('GroupsDefinition')
    // School starter groups: teacher (updates own grades) + coordinator (school-wide).
    expect(groups).toContain('teacher:')
    expect(groups).toContain("'grades.update': 'owned'")

    // Fastify domains variant.
    expect(domains).toContain('kyroguardFastify')
    expect(domains).not.toContain('kyroguardExpress')
    expect(domains).not.toContain('{{DOMAIN}}')

    // The pg schema defines exactly the 6 kyroguard tables.
    expect(schema).toContain('pgTable')
    const tables = [...schema.matchAll(/pgTable\(\s*'([a-z_]+)'/g)].map(match => match[1])
    expect(tables.toSorted()).toEqual(KYROGUARD_TABLES.toSorted())
  })

  test('re-running init skips files that already exist', async () => {
    const cwd = await projectDir({ fastify: '^5.0.0', 'drizzle-orm': '^0.36.0', pg: '^8.13.0' })
    await runInitQuiet(cwd)

    // Simulate the user having customized two of the files.
    const configMarker = '// customized-by-user config\n'
    const schemaMarker = '// customized-by-user schema\n'
    await writeFile(join(cwd, 'kyroguard.config.ts'), configMarker, 'utf8')
    await writeFile(join(cwd, 'src', 'db', 'kyroguard-schema.ts'), schemaMarker, 'utf8')

    const lines = await runInitQuiet(cwd)

    // --yes never overwrites: every planned file already exists → all skipped.
    const skipped = lines.filter(line => line.includes('skipped'))
    expect(skipped.length).toBe(5)
    expect(lines.some(line => line.includes('wrote'))).toBe(false)

    expect(await readFile(join(cwd, 'kyroguard.config.ts'), 'utf8')).toBe(configMarker)
    expect(await readFile(join(cwd, 'src', 'db', 'kyroguard-schema.ts'), 'utf8')).toBe(schemaMarker)
  })

  test('re-running restores only files the user deleted, leaving the rest untouched', async () => {
    const cwd = await projectDir({ fastify: '^5.0.0', 'drizzle-orm': '^0.36.0', pg: '^8.13.0' })
    await runInitQuiet(cwd)

    const configMarker = '// keep me\n'
    await writeFile(join(cwd, 'kyroguard.config.ts'), configMarker, 'utf8')
    await rm(join(cwd, 'src', 'kyroguard', 'groups', 'admin.ts'))

    const lines = await runInitQuiet(cwd)
    expect(lines.some(line => line.includes('wrote') && line.includes(join('groups', 'admin.ts')))).toBe(true)
    expect(existsSync(join(cwd, 'src', 'kyroguard', 'groups', 'admin.ts'))).toBe(true)
    expect(await readFile(join(cwd, 'kyroguard.config.ts'), 'utf8')).toBe(configMarker)
  })

  test('express + mongoose project gets the mongoose config, express domains and NO schema file', async () => {
    const cwd = await projectDir({ express: '^4.21.0', mongoose: '^8.9.0' })
    const lines = await runInitQuiet(cwd)

    expect(lines.join('\n')).toContain('framework: express')
    expect(lines.join('\n')).toContain('orm:       mongoose')

    const config = await readFile(join(cwd, 'kyroguard.config.ts'), 'utf8')
    expect(config).toContain('mongooseAdapter')
    expect(config).not.toContain('drizzleAdapter')
    expect(config).toContain("domains: './src/kyroguard'")

    const domains = await readFile(join(cwd, 'src', 'kyroguard', 'domains.ts'), 'utf8')
    expect(domains).toContain('kyroguardExpress')
    expect(domains).not.toContain('kyroguardFastify')

    // Mongoose owns its indexes via ensureSchema — no drizzle schema file.
    expect(existsSync(join(cwd, 'src', 'db', 'kyroguard-schema.ts'))).toBe(false)
    expect(existsSync(join(cwd, 'src', 'db'))).toBe(false)

    // Starter policies/groups are ORM-independent and still written.
    expect(existsSync(join(cwd, 'src', 'kyroguard', 'policies', 'admin.ts'))).toBe(true)
    expect(existsSync(join(cwd, 'src', 'kyroguard', 'groups', 'admin.ts'))).toBe(true)
  })

  test('fastify + prisma project gets the prisma config, prisma/kyroguard.prisma and NO drizzle schema', async () => {
    const cwd = await projectDir({ fastify: '^5.0.0', '@prisma/client': '^6.0.0' }, { prisma: '^6.0.0' })
    await mkdir(join(cwd, 'prisma'), { recursive: true })
    await writeFile(join(cwd, 'prisma', 'schema.prisma'), prismaSchemaSource('postgresql'), 'utf8')

    const lines = await runInitQuiet(cwd)

    // Detection: prisma orm, dialect parsed from the datasource provider
    // (the generator's "prisma-client-js" provider must not match).
    expect(lines.join('\n')).toContain('framework: fastify')
    expect(lines.join('\n')).toContain('orm:       prisma')
    expect(lines.join('\n')).toContain('dialect:   pg')

    // Prisma config variant with the lazy adapter factory.
    const config = await readFile(join(cwd, 'kyroguard.config.ts'), 'utf8')
    expect(config).toContain("await import('@prisma/client')")
    expect(config).toContain("await import('@kyrobit/kyroguard/prisma')")
    expect(config).toContain('prismaAdapter(new PrismaClient())')
    expect(config).not.toContain('drizzleAdapter')
    expect(config).toContain("domains: './src/kyroguard'")
    expect(config).not.toContain('{{DOMAIN}}')

    // The snippet lands in prisma/ with all six models mapped to the kyroguard tables.
    const snippet = await readFile(join(cwd, 'prisma', 'kyroguard.prisma'), 'utf8')
    for (const model of PRISMA_MODELS) expect(snippet).toContain(`model ${model} {`)
    for (const table of KYROGUARD_TABLES) expect(snippet).toContain(`@@map("${table}")`)
    // Header tells the user how to include it.
    expect(snippet).toContain('prismaSchemaFolder')
    expect(snippet).toContain('prisma migrate dev')

    // Starter policies/groups/wiring still land; no drizzle schema file.
    expect(existsSync(join(cwd, 'src', 'kyroguard', 'policies', 'admin.ts'))).toBe(true)
    expect(existsSync(join(cwd, 'src', 'kyroguard', 'groups', 'admin.ts'))).toBe(true)
    const domains = await readFile(join(cwd, 'src', 'kyroguard', 'domains.ts'), 'utf8')
    expect(domains).toContain('kyroguardFastify')
    expect(existsSync(join(cwd, 'src', 'db'))).toBe(false)

    // Next steps mention the migration flow.
    expect(lines.join('\n')).toContain('prisma migrate dev')
    expect(lines.join('\n')).toContain('kyroguard sync')
  })

  test('re-running init on a prisma project skips every existing file', async () => {
    const cwd = await projectDir({ '@prisma/client': '^6.0.0' }, { prisma: '^6.0.0' })
    await mkdir(join(cwd, 'prisma'), { recursive: true })
    await writeFile(join(cwd, 'prisma', 'schema.prisma'), prismaSchemaSource('postgresql'), 'utf8')
    await runInitQuiet(cwd)

    const snippetMarker = '// customized-by-user snippet\n'
    await writeFile(join(cwd, 'prisma', 'kyroguard.prisma'), snippetMarker, 'utf8')

    const lines = await runInitQuiet(cwd)

    // --yes never overwrites: config, policies, groups, domains, kyroguard.prisma.
    const skipped = lines.filter(line => line.includes('skipped'))
    expect(skipped.length).toBe(5)
    expect(lines.some(line => line.includes('wrote'))).toBe(false)
    expect(await readFile(join(cwd, 'prisma', 'kyroguard.prisma'), 'utf8')).toBe(snippetMarker)
  })

  test('root-level schema.prisma without a prisma/ dir puts kyroguard.prisma next to it', async () => {
    const cwd = await projectDir({ '@prisma/client': '^6.0.0' }, { prisma: '^6.0.0' })
    await writeFile(join(cwd, 'schema.prisma'), prismaSchemaSource('sqlite'), 'utf8')

    const lines = await runInitQuiet(cwd)
    expect(lines.join('\n')).toContain('dialect:   sqlite')

    expect(existsSync(join(cwd, 'prisma'))).toBe(false)
    const snippet = await readFile(join(cwd, 'kyroguard.prisma'), 'utf8')
    for (const model of PRISMA_MODELS) expect(snippet).toContain(`model ${model} {`)
  })

  test('project with both drizzle-orm and prisma installed prefers drizzle', async () => {
    const cwd = await projectDir({
      fastify: '^5.0.0',
      'drizzle-orm': '^0.36.0',
      '@prisma/client': '^6.0.0',
      pg: '^8.13.0',
    })
    const lines = await runInitQuiet(cwd)

    expect(lines.join('\n')).toContain('orm:       drizzle')

    const config = await readFile(join(cwd, 'kyroguard.config.ts'), 'utf8')
    expect(config).toContain('drizzleAdapter')
    expect(config).not.toContain('prismaAdapter')

    expect(existsSync(join(cwd, 'src', 'db', 'kyroguard-schema.ts'))).toBe(true)
    expect(existsSync(join(cwd, 'prisma', 'kyroguard.prisma'))).toBe(false)
    expect(existsSync(join(cwd, 'kyroguard.prisma'))).toBe(false)
  })

  test('empty project falls back to fastify + drizzle + pg defaults under --yes', async () => {
    const cwd = await projectDir({})
    await runInitQuiet(cwd)

    const config = await readFile(join(cwd, 'kyroguard.config.ts'), 'utf8')
    expect(config).toContain('drizzleAdapter')
    const domains = await readFile(join(cwd, 'src', 'kyroguard', 'domains.ts'), 'utf8')
    expect(domains).toContain('kyroguardFastify')
    const schema = await readFile(join(cwd, 'src', 'db', 'kyroguard-schema.ts'), 'utf8')
    expect(schema).toContain("pgTable('kyroguard_policies'")
  })
})
