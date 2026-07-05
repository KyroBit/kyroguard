// Copies CLI scaffolding templates (not compiled by tsc) into dist.
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src/cli/templates')
const out = join(root, 'dist/cli/templates')

await mkdir(dirname(out), { recursive: true })
await cp(src, out, { recursive: true })
console.log('[build] copied CLI templates')
