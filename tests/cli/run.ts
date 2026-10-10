/// <reference types="bun-types" />
/** Spawns the real CLI entry against a fixture project, as a seed script would. */

import { relative } from 'node:path'
import { join } from 'node:path'

export const CLI = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts')
export const DIST_CLI = join(import.meta.dir, '..', '..', 'dist', 'cli', 'index.js')
export const SRC_TESTING = join(import.meta.dir, '..', '..', 'src', 'testing', 'index.ts')

/** Generous for CI; the child normally exits in well under a second. */
export const EXIT_DEADLINE_MS = 20_000

export interface CliResult {
  exitCode: number | 'timeout'
  stdout: string
  stderr: string
}

export async function runCli(
  args: string[],
  cwd: string,
  entry: { runtime: string; cli: string } = { runtime: process.execPath, cli: CLI },
): Promise<CliResult> {
  const child = Bun.spawn([entry.runtime, entry.cli, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  let timer: ReturnType<typeof setTimeout> | undefined
  const exitCode = await Promise.race([
    child.exited,
    new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), EXIT_DEADLINE_MS)
    }),
  ])
  clearTimeout(timer)
  if (exitCode === 'timeout') child.kill()
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

export function relativeImport(fromDir: string, toFile: string): string {
  const spec = relative(fromDir, toFile).split('\\').join('/')
  return spec.startsWith('.') ? spec : `./${spec}`
}

/**
 * A JS string literal for a fixture source file. U+2028/U+2029 are legal in
 * modern string literals but escaped anyway so older parsers cannot see a
 * line terminator mid-literal.
 */
export function jsString(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}
