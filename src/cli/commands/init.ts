import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { detectStack } from '../detect.js'
import type { DetectedStack } from '../detect.js'
// A pure string constant — this import keeps the CLI free of DB drivers and ORMs.
import { prismaSchemaSnippet } from '../../storage/prisma/schema-snippet.js'

export interface InitOptions {
  cwd: string
  yes: boolean
}

interface Answers {
  framework: 'fastify' | 'express'
  orm: 'drizzle' | 'prisma' | 'mongoose'
  dialect: 'pg' | 'mysql' | 'sqlite'
  domain: string
}

/** A planned file comes from a template on disk or from literal content. */
type PlannedFile =
  | { dest: string; template: string }
  | { dest: string; content: string }

const CONFIG_TEMPLATES: Record<Answers['orm'], string> = {
  drizzle: 'kyroguard-config-drizzle.ts.tpl',
  prisma: 'kyroguard-config-prisma.ts.tpl',
  mongoose: 'kyroguard-config-mongoose.ts.tpl',
}

/**
 * domains.ts adapter wiring per ORM. Construction mirrors kyroguard.config.ts,
 * but reuses the app's own client (the TODO import) instead of opening one.
 */
const ADAPTER_WIRING: Record<Answers['orm'], { imports: string; create: string }> = {
  drizzle: {
    imports: [
      "import { drizzleAdapter } from '@kyrobit/kyroguard/drizzle'",
      "import * as schema from '../db/kyroguard-schema.js'",
      "// TODO: import your app's drizzle instance:",
      "import { db } from '../db/index.js'",
    ].join('\n'),
    create: 'const adapter = drizzleAdapter(db, { schema })',
  },
  prisma: {
    imports: [
      "import { prismaAdapter } from '@kyrobit/kyroguard/prisma'",
      "// TODO: import your app's PrismaClient instance:",
      "import { prisma } from '../db/client.js'",
    ].join('\n'),
    create: 'const adapter = prismaAdapter(prisma)',
  },
  mongoose: {
    imports: [
      "import { mongooseAdapter } from '@kyrobit/kyroguard/mongoose'",
      "// TODO: import your app's mongoose connection:",
      "import { connection } from '../db/connection.js'",
    ].join('\n'),
    create: 'const adapter = mongooseAdapter(connection)',
  },
}

const PRISMA_SNIPPET_HEADER = `// @kyrobit/kyroguard tables — scaffolded by \`kyroguard init\`.
//
// Include these models in your Prisma schema, either by:
//   1. enabling multi-file schemas (the \`prismaSchemaFolder\` preview feature;
//      built in on recent Prisma versions) so this file is picked up alongside
//      schema.prisma, or
//   2. pasting the models below into schema.prisma directly.
//
// Then run your migration: npx prisma migrate dev

`

// From dist/cli/commands/*.js and src/cli/commands/*.ts alike, templates sit
// one level up — copy-templates.mjs preserves the layout in dist.
const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url))

export async function run(options: InitOptions): Promise<void> {
  const detected = detectStack(options.cwd)
  printDetected(detected)

  const answers = options.yes ? defaults(detected) : await prompt(detected)

  const substitutions: Record<string, string> = {
    '{{DOMAIN}}': answers.domain,
    '{{DOMAIN_EXPORT}}': toIdentifier(answers.domain),
    '{{DIALECT}}': answers.dialect,
    '{{ADAPTER_IMPORTS}}': ADAPTER_WIRING[answers.orm].imports,
    '{{ADAPTER_CREATE}}': ADAPTER_WIRING[answers.orm].create,
  }

  // Convention layout: policies/<domain>.ts + groups/<domain>.ts — the config
  // points at the directory and the CLI derives the domains from file names.
  const plan: PlannedFile[] = [
    { dest: 'kyroguard.config.ts', template: CONFIG_TEMPLATES[answers.orm] },
    {
      dest: join('src', 'kyroguard', 'policies', `${answers.domain}.ts`),
      template: 'policies-starter.ts.tpl',
    },
    {
      dest: join('src', 'kyroguard', 'groups', `${answers.domain}.ts`),
      template: 'groups-starter.ts.tpl',
    },
    {
      dest: join('src', 'kyroguard', 'domains.ts'),
      template:
        answers.framework === 'express'
          ? 'kyroguard-domains-express.ts.tpl'
          : 'kyroguard-domains-fastify.ts.tpl',
    },
  ]
  if (answers.orm === 'drizzle') {
    plan.push({
      dest: join('src', 'db', 'kyroguard-schema.ts'),
      template: `schema-drizzle-${answers.dialect}.ts.tpl`,
    })
  }
  const prismaSchemaDest = answers.orm === 'prisma' ? prismaSnippetDest(options.cwd) : null
  if (prismaSchemaDest !== null) {
    plan.push({ dest: prismaSchemaDest, content: PRISMA_SNIPPET_HEADER + prismaSchemaSnippet })
  }

  const rl = options.yes ? null : createInterface({ input: stdin, output: stdout })
  try {
    for (const file of plan) {
      const destination = join(options.cwd, file.dest)
      if (existsSync(destination)) {
        const overwrite = rl
          ? await confirm(rl, `${file.dest} already exists — overwrite?`, false)
          : false
        if (!overwrite) {
          console.log(`  skipped ${file.dest} (already exists)`)
          continue
        }
      }
      const raw =
        'template' in file ? await readFile(join(TEMPLATES_DIR, file.template), 'utf8') : file.content
      const content = substitute(raw, substitutions)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, content, 'utf8')
      console.log(`  wrote   ${file.dest}`)
    }
  } finally {
    rl?.close()
  }

  console.log('')
  console.log('[kyroguard] Next steps:')
  if (answers.orm === 'drizzle') {
    console.log('  1. Add src/db/kyroguard-schema.ts to your drizzle config schema paths.')
    console.log('  2. Run your migrations (drizzle-kit generate && drizzle-kit migrate, or push).')
    console.log('  3. Finish the TODOs in kyroguard.config.ts and src/kyroguard/domains.ts.')
    console.log('  4. Run `kyroguard sync`.')
  } else if (prismaSchemaDest !== null) {
    console.log(`  1. Include ${prismaSchemaDest} in your Prisma schema — enable multi-file`)
    console.log('     schemas (prismaSchemaFolder) or paste its models into schema.prisma.')
    console.log('  2. Run your migrations (npx prisma migrate dev, or prisma db push).')
    console.log('  3. Finish the TODOs in kyroguard.config.ts and src/kyroguard/domains.ts.')
    console.log('  4. Run `kyroguard sync`.')
  } else {
    console.log('  1. Finish the TODOs in kyroguard.config.ts and src/kyroguard/domains.ts.')
    console.log('  2. Run `kyroguard sync` (creates the MongoDB indexes via ensureSchema).')
  }
}

function prismaSnippetDest(cwd: string): string {
  if (!existsSync(join(cwd, 'prisma')) && existsSync(join(cwd, 'schema.prisma'))) {
    return 'kyroguard.prisma'
  }
  return join('prisma', 'kyroguard.prisma')
}

/** Domain name as a safe export identifier: 'my-app' → 'myApp', '2fa' → '_2fa'. */
function toIdentifier(name: string): string {
  const camel = name.replace(/[^\p{L}\p{N}$_]+(.)?/gu, (_, next: string | undefined) =>
    next ? next.toUpperCase() : '',
  )
  if (camel === '') return 'domain'
  return /^[\p{L}$_]/u.test(camel) ? camel : `_${camel}`
}

function printDetected(detected: DetectedStack): void {
  const show = (value: string | null) => value ?? 'not detected'
  console.log('[kyroguard] Detected stack:')
  console.log(`  framework: ${show(detected.framework)}`)
  console.log(`  orm:       ${show(detected.orm)}`)
  console.log(`  dialect:   ${show(detected.dialect)}`)
  console.log('')
}

function defaults(detected: DetectedStack): Answers {
  return {
    framework: detected.framework ?? 'fastify',
    orm: detected.orm ?? 'drizzle',
    dialect: detected.dialect ?? 'pg',
    domain: 'admin',
  }
}

async function prompt(detected: DetectedStack): Promise<Answers> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const framework = await choose(rl, 'Framework', ['fastify', 'express'], detected.framework ?? 'fastify')
    const orm = await choose(rl, 'ORM', ['drizzle', 'prisma', 'mongoose'], detected.orm ?? 'drizzle')
    const dialect =
      orm === 'drizzle'
        ? await choose(rl, 'Dialect', ['pg', 'mysql', 'sqlite'], detected.dialect ?? 'pg')
        : (detected.dialect ?? 'pg')
    const domain = await ask(rl, 'Domain name', 'admin')
    return { framework, orm, dialect, domain }
  } finally {
    rl.close()
  }
}

type PromptInterface = ReturnType<typeof createInterface>

async function ask(rl: PromptInterface, question: string, fallback: string): Promise<string> {
  const answer = (await rl.question(`${question} [${fallback}]: `)).trim()
  return answer === '' ? fallback : answer
}

async function choose<const T extends string>(
  rl: PromptInterface,
  question: string,
  choices: readonly T[],
  fallback: T,
): Promise<T> {
  for (;;) {
    const answer = (await rl.question(`${question} (${choices.join('/')}) [${fallback}]: `))
      .trim()
      .toLowerCase()
    if (answer === '') return fallback
    const match = choices.find(choice => choice === answer)
    if (match) return match
    console.log(`  Please answer one of: ${choices.join(', ')}`)
  }
}

async function confirm(rl: PromptInterface, question: string, fallback: boolean): Promise<boolean> {
  const answer = (await rl.question(`${question} (${fallback ? 'Y/n' : 'y/N'}): `))
    .trim()
    .toLowerCase()
  if (answer === '') return fallback
  return answer === 'y' || answer === 'yes'
}

function substitute(content: string, substitutions: Record<string, string>): string {
  let result = content
  for (const [placeholder, value] of Object.entries(substitutions)) {
    result = result.replaceAll(placeholder, value)
  }
  return result
}
