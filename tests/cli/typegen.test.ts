import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { generateTypes } from '../../src/cli/typegen.js'
import type { PortalTypeInfo } from '../../src/cli/typegen.js'

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

let fileCounter = 0

async function generate(portals: PortalTypeInfo[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rbac-typegen-'))
  roots.push(root)
  const output = join(root, 'nested', `rbac-${++fileCounter}.d.ts`)
  await generateTypes(portals, output)
  return await readFile(output, 'utf8')
}

/** Syntactic diagnostics only — module augmentation of an unresolved package
 * is a semantic concern; syntax is what injection would break. */
function syntaxErrors(text: string): readonly ts.Diagnostic[] {
  return ts.transpileModule(text, { reportDiagnostics: true }).diagnostics ?? []
}

interface ParsedDeclaration {
  moduleCount: number
  moduleName: string
  interfaceName: string
  memberNames: string[]
  portalUnion: string[]
  policyUnion: string[]
  /** portal name → union of policy literals ('string' fallback → ['string']). */
  portalPolicies: Map<string, string[]>
}

/** Parse the generated file and pull the DECODED string-literal values back
 * out of the AST. If escaping is broken these decode to different strings
 * (or the file stops parsing), so round-tripping every hostile name through
 * the AST is the strongest injection assertion available. */
function parseDeclaration(text: string): ParsedDeclaration {
  const source = ts.createSourceFile('rbac.d.ts', text, ts.ScriptTarget.Latest, true)
  const modules = source.statements.filter(ts.isModuleDeclaration)
  expect(modules).toHaveLength(1)
  const moduleDecl = modules[0]!
  const body = moduleDecl.body
  if (body === undefined || !ts.isModuleBlock(body)) throw new Error('module has no block body')

  const interfaces = body.statements.filter(ts.isInterfaceDeclaration)
  expect(interfaces).toHaveLength(1)
  const iface = interfaces[0]!

  const typeOf = (memberName: string): ts.TypeNode => {
    const member = iface.members
      .filter(ts.isPropertySignature)
      .find(entry => entry.name.getText(source) === memberName || propertyKeyText(entry) === memberName)
    if (!member?.type) throw new Error(`interface member ${memberName} not found`)
    return member.type
  }

  const portalPolicies = new Map<string, string[]>()
  const portalPoliciesType = typeOf('PortalPolicies')
  if (ts.isTypeLiteralNode(portalPoliciesType)) {
    for (const member of portalPoliciesType.members) {
      if (!ts.isPropertySignature(member) || !member.type) throw new Error('bad PortalPolicies member')
      portalPolicies.set(propertyKeyText(member), unionLiterals(member.type))
    }
  }

  return {
    moduleCount: modules.length,
    moduleName: ts.isStringLiteral(moduleDecl.name) ? moduleDecl.name.text : moduleDecl.name.getText(source),
    interfaceName: iface.name.text,
    memberNames: iface.members
      .filter(ts.isPropertySignature)
      .map(member => propertyKeyText(member)),
    portalUnion: unionLiterals(typeOf('Portal')),
    policyUnion: unionLiterals(typeOf('PolicyName')),
    portalPolicies,
  }
}

/** Decoded property-key text: identifier text or the string literal's value. */
function propertyKeyText(member: ts.PropertySignature): string {
  const name = member.name
  if (ts.isStringLiteral(name)) return name.text
  if (ts.isIdentifier(name)) return name.text
  return name.getText()
}

/** Flattens a string-literal union to decoded values; bare `string` → ['string']. */
function unionLiterals(node: ts.TypeNode): string[] {
  if (ts.isUnionTypeNode(node)) return node.types.flatMap(unionLiterals)
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return [node.literal.text]
  if (node.kind === ts.SyntaxKind.StringKeyword) return ['string']
  throw new Error(`unexpected type node kind ${ts.SyntaxKind[node.kind]}`)
}

describe('generateTypes', () => {
  test('plain names: valid TS augmenting @kyrobit/rbac RbacTypes', async () => {
    const text = await generate([
      { name: 'admin', policyNames: ['posts.read', 'posts.create'] },
      { name: 'customer', policyNames: ['posts.read'] },
    ])

    expect(syntaxErrors(text)).toHaveLength(0)
    // `export {}` keeps the file a module so `declare module` AUGMENTS the package.
    expect(text).toContain('export {}')
    expect(text).toContain("declare module '@kyrobit/rbac'")

    const parsed = parseDeclaration(text)
    expect(parsed.moduleName).toBe('@kyrobit/rbac')
    expect(parsed.interfaceName).toBe('RbacTypes')
    expect(parsed.memberNames).toEqual(['Portal', 'PolicyName', 'PortalPolicies'])
    expect(parsed.portalUnion.toSorted()).toEqual(['admin', 'customer'])
    // PolicyName is deduped across portals.
    expect(parsed.policyUnion.toSorted()).toEqual(['posts.create', 'posts.read'])
    expect(parsed.portalPolicies.get('admin')?.toSorted()).toEqual(['posts.create', 'posts.read'])
    expect(parsed.portalPolicies.get('customer')).toEqual(['posts.read'])
  })

  test('hostile names (quotes, backslashes, unicode breaks) cannot inject declarations', async () => {
    // Each of these broke or escaped the string context in the v0 raw
    // interpolation: closing quote + union pivot, double quotes, trailing
    // backslash (would swallow the closing quote), U+2028/U+2029 (legal in
    // JSON, line terminators in older JS), and plain unicode.
    const portalName = `admin" } | { evil: 'x`
    const policyNames = [
      `read' | 'pwn`,
      `say "hi"`,
      `trailing\\`,
      'line\u2028sep\u2029arator',
      'pörtal.日本語',
    ]
    const text = await generate([{ name: portalName, policyNames }])

    // Still exactly one module block, one interface, three members — nothing
    // was injected out of the string context.
    expect(syntaxErrors(text)).toHaveLength(0)
    const parsed = parseDeclaration(text)
    expect(parsed.moduleCount).toBe(1)
    expect(parsed.moduleName).toBe('@kyrobit/rbac')
    expect(parsed.memberNames).toEqual(['Portal', 'PolicyName', 'PortalPolicies'])

    // Every hostile name round-trips through the AST byte-for-byte.
    expect(parsed.portalUnion).toEqual([portalName])
    expect(parsed.policyUnion.toSorted()).toEqual(policyNames.toSorted())
    // Property keys are quoted too (the v0 regression hit keys AND literals).
    expect([...parsed.portalPolicies.keys()]).toEqual([portalName])
    expect(parsed.portalPolicies.get(portalName)?.toSorted()).toEqual(policyNames.toSorted())

    // Textual double-check of the mechanism: both the key and the literals
    // appear JSON.stringify-quoted, never raw.
    expect(text).toContain(`${JSON.stringify(portalName)}:`)
    for (const name of policyNames) expect(text).toContain(JSON.stringify(name))
    expect(text).not.toContain(`'${portalName}'`)
  })

  test('single-quoted name stays inside its double-quoted literal', async () => {
    const text = await generate([{ name: "o'brien", policyNames: ["it's.fine"] }])
    expect(syntaxErrors(text)).toHaveLength(0)
    const parsed = parseDeclaration(text)
    expect(parsed.portalUnion).toEqual(["o'brien"])
    expect(parsed.policyUnion).toEqual(["it's.fine"])
    expect(text).toContain('"o\'brien"')
  })

  test('empty portals → string fallbacks everywhere', async () => {
    const text = await generate([])
    expect(syntaxErrors(text)).toHaveLength(0)
    expect(text).toContain('Portal: string')
    expect(text).toContain('PolicyName: string')
    expect(text).toContain('PortalPolicies: Record<string, string>')
  })

  test('portal with no policies → string fallback for its policy union', async () => {
    const text = await generate([{ name: 'admin', policyNames: [] }])
    expect(syntaxErrors(text)).toHaveLength(0)
    const parsed = parseDeclaration(text)
    expect(parsed.portalUnion).toEqual(['admin'])
    expect(parsed.policyUnion).toEqual(['string'])
    expect(parsed.portalPolicies.get('admin')).toEqual(['string'])
  })

  test("portal-less sentinel '' is emitted as an (escaped) empty-string key", async () => {
    const text = await generate([{ name: '', policyNames: ['posts.read'] }])
    expect(syntaxErrors(text)).toHaveLength(0)
    const parsed = parseDeclaration(text)
    expect(parsed.portalUnion).toEqual([''])
    expect([...parsed.portalPolicies.keys()]).toEqual([''])
    expect(parsed.portalPolicies.get('')).toEqual(['posts.read'])
  })

  test('duplicate names are deduped and unions sorted', async () => {
    const text = await generate([
      { name: 'admin', policyNames: ['b.z', 'a.z', 'b.z'] },
    ])
    const parsed = parseDeclaration(text)
    expect(parsed.policyUnion).toEqual(['a.z', 'b.z'])
    expect(parsed.portalPolicies.get('admin')).toEqual(['a.z', 'b.z'])
  })

  test('creates missing output directories', async () => {
    // generate() already targets a nested/ subdir that does not exist —
    // reaching this assertion proves mkdir recursive ran.
    const text = await generate([{ name: 'admin', policyNames: ['x.y'] }])
    expect(text.length).toBeGreaterThan(0)
  })
})
