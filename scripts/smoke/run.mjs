// Packs the built package, installs the tarball into a throwaway fixture,
// and runs the real-runtime assertions in check.mjs under plain Node.
// Catches exports-map, ESM-resolution and peer-wiring breakage that
// unit tests under Bun cannot.
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const packOutput = execFileSync('npm', ['pack', '--json'], { cwd: root, encoding: 'utf8' })
const tarball = join(root, JSON.parse(packOutput)[0].filename)
console.log(`[smoke] packed ${tarball}`)

const fixture = await mkdtemp(join(tmpdir(), 'rbac-smoke-'))
try {
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify(
      {
        name: 'rbac-smoke-fixture',
        private: true,
        type: 'module',
        dependencies: {
          '@kyrobit/rbac': `file:${tarball}`,
          express: '^5.1.0',
          fastify: '^5.0.0',
        },
      },
      null,
      2,
    ),
  )

  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: fixture,
    stdio: 'inherit',
  })

  await cp(join(root, 'scripts/smoke/check.mjs'), join(fixture, 'check.mjs'))
  execFileSync('node', ['check.mjs'], { cwd: fixture, stdio: 'inherit' })
  console.log('[smoke] all checks passed under Node', process.version)
} finally {
  await rm(fixture, { recursive: true, force: true })
  await rm(tarball, { force: true })
}
