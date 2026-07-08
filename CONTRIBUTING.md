# Contributing

## Setup

```bash
bun install
```

## Development commands

| Command | Purpose |
|---|---|
| `bun run typecheck` | TypeScript, strict, includes tests |
| `bun test tests/` | Full test suite |
| `bun run build` | Compile to `dist/` and copy CLI templates |
| `bun run lint:package` | publint + arethetypeswrong against the build |

## Layering rules

The import direction is enforced by review and must never be violated:

```
src/core/        imports nothing framework- or ORM-specific
src/cache/       imports core types only
src/storage/*    imports core + its own ORM (optional peer)
src/frameworks/* imports core + its own framework (optional peer)
src/cli/         imports core + jiti — never a DB driver or ORM
src/testing/     imports the public core surface only
```

`src/storage/contract.ts` is normative: its numbered clauses (S1–S23) map
1:1 to cases in `src/testing/adapter-suite.ts`. Changing adapter behavior
means changing the clause, the suite, and every adapter together.

## Comments

The docs are the single source of truth — API behavior, examples and
rationale belong in `docs/`, not in code comments. A comment is justified
only for a constraint the code cannot express and a future edit would
silently break: a security invariant, a cross-runtime quirk (e.g. Bun's
AsyncLocalStorage propagation), a contract-clause reference. Narration,
restated docs content, and "why this change is correct" notes get removed
in review.

## Tests

Every storage adapter must pass `runStorageAdapterContractSuite`. Every
framework integration must pass `runFrameworkContractSuite`. Bug fixes ship
with a regression test named after the defect they fix.

## Testing against a real app (`bun link`)

Linking an app to this checkout exposes the app's TypeScript to the
checkout's devDependency copies of the framework peers (fastify, express).
TypeScript only merges `declare module` augmentations (the one that adds
`app.kyroguard`) across two package copies when name **and version** match —
version drift produces `Property 'kyroguard' is missing in type
'FastifyInstance'`. Two fixes, either works:

- pin the app's fastify to the exact version in this checkout's lockfile, or
- force a single copy in the app's tsconfig:
  `{ "compilerOptions": { "paths": { "fastify": ["./node_modules/fastify"] } } }`

Registry installs are never affected — the published tarball ships only
`dist/` with no nested `node_modules`, so exactly one fastify resolves.

## Releases

CI publishes to GitHub Packages on `v*` tags, gated on tests and package
lint. Bump the version in `package.json`, tag, push the tag.
