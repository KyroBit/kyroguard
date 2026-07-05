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

## Releases

CI publishes to GitHub Packages on `v*` tags, gated on tests and package
lint. Bump the version in `package.json`, tag, push the tag.
