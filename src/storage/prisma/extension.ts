import { MisconfiguredError } from '../../core/errors.js'
import type { GuardEngine } from '../../core/engine.js'
import type { StorageAdapter } from '../contract.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ScopeResourceRegistration {
  /** The resource type the guard activates a filter under, e.g. 'post'. */
  type: string
  /** The Prisma client delegate key, case-exact (`model BlogPost` → `'blogPost'`). */
  model: string
}

export interface ScopeExtensionOptions {
  guard: {
    engine: GuardEngine
    adapter: StorageAdapter
  }
  resources: ScopeResourceRegistration[]
}

/** The params Prisma passes to a `query` extension hook (structural subset). */
interface QueryHookParams {
  model: string
  args: any
  query: (args: any) => Promise<any>
}

type QueryHook = (params: QueryHookParams) => Promise<any>

/** The extension object shape for `client.$extends(...)`; structural — src/ never imports `@prisma/client`. */
export interface ScopeExtension {
  name: string
  query: Record<string, Record<string, QueryHook>>
}

type CreateOperation = 'create' | 'createMany'
type ReadOperation = 'findMany' | 'findFirst' | 'findUnique' | 'count'
type WriteOperation = 'updateMany' | 'deleteMany' | 'update' | 'delete'
type FilteredOperation = ReadOperation | WriteOperation

const CREATE_OPERATIONS: CreateOperation[] = ['create', 'createMany']
const READ_OPERATIONS: ReadOperation[] = ['findMany', 'findFirst', 'findUnique', 'count']
/** Writes carry the same filter: a grant that narrows reads must narrow writes by as much. */
const WRITE_OPERATIONS: WriteOperation[] = ['updateMany', 'deleteMany', 'update', 'delete']

/** update/delete take a unique where, so the fragment is ANDed rather than replacing it. */
const TAKES_UNIQUE_WHERE = new Set<FilteredOperation>(['findUnique', 'update', 'delete'])
const AFFECTS_MANY = new Set<FilteredOperation>(['updateMany', 'deleteMany'])

// Prisma hands query hooks the schema model name ('BlogPost') while
// registrations carry the delegate key ('blogPost') — normalize both.
function delegateKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1)
}

// findUnique's WhereUniqueInput requires the unique selector at the TOP level,
// so the kyroguard fragment may only ride AND — never wrap the whole where.
function mergeUniqueWhere(where: Record<string, unknown>, fragment: unknown): Record<string, unknown> {
  const existing = where['AND']
  const conditions =
    existing === undefined
      ? [fragment]
      : Array.isArray(existing)
        ? [...existing, fragment]
        : [existing, fragment]
  return { ...where, AND: conditions }
}

/**
 * The grant's insert columns are the same fact its filter reads by, so a row
 * created with a different value would be invisible to its creator.
 */
function applyStamp(
  row: Record<string, unknown>,
  stamp: Record<string, unknown>,
  type: string,
): Record<string, unknown> {
  const next = { ...row }
  for (const [column, value] of Object.entries(stamp)) {
    if (next[column] !== undefined && next[column] !== value) {
      throw new MisconfiguredError(
        `[kyroguard] create on "${type}": the grant sets "${column}" to ${JSON.stringify(value)}, ` +
          `but this create passes ${JSON.stringify(next[column])} — the row would be unreadable ` +
          `to whoever created it.`,
      )
    }
    next[column] = value
  }
  return next
}

/**
 * Prisma client extension: merges the request's guard-activated filter into
 * every query for a registered model — reads (findMany/findFirst/findUnique/
 * count) and writes (update/delete/updateMany/deleteMany) alike, so a row the
 * scope excludes can be neither read nor written. Creates carry the grant's
 * insert columns instead of a filter — a row created under a grant must be one
 * the same grant can read back. Interception gaps (raw SQL, nested writes, …)
 * are documented in docs/reference/prisma.md.
 */
export function scopeExtension(options: ScopeExtensionOptions): ScopeExtension {
  const { engine, adapter } = options.guard

  const typeForModel = new Map<string, string>()
  for (const registration of options.resources) {
    typeForModel.set(delegateKey(registration.model), registration.type)
  }

  const query: Record<string, Record<string, QueryHook>> = {}
  if (typeForModel.size === 0) return { name: '@kyrobit/kyroguard', query }

  const filteredHook =
    (operation: FilteredOperation): QueryHook =>
    async ({ model, args, query: run }: QueryHookParams): Promise<any> => {
      const type = typeForModel.get(delegateKey(model))
      if (type === undefined) return run(args)
      // Scope filters must see the unfiltered table — the isInAuthz contract
      // (core/engine.ts).
      if (engine.store.isInAuthz()) return run(args)
      const filter = engine.store.getActiveFilter(type)
      if (!filter || filter.kind === 'all') return run(args)

      if (filter.kind === 'none') {
        if (operation === 'findMany') return []
        if (operation === 'count') return 0
        if (AFFECTS_MANY.has(operation)) return { count: 0 }
        if (operation === 'findFirst' || operation === 'findUnique') return null
      }

      // A closed filter still runs for update/delete, so Prisma raises its own
      // not-found rather than this extension inventing a return shape. It has
      // to be the adapter's field-level impossible predicate: inside a
      // WhereUniqueInput, Prisma folds every boolean "always false" away —
      // NOT:{}, OR:[] and AND:[] each compile to no condition at all, and the
      // write would land on the row the scope denied.
      const fragment = filter.kind === 'none' ? adapter.listFilters!.none() : filter.where
      const where: unknown = (args as { where?: unknown } | null | undefined)?.where
      const merged = TAKES_UNIQUE_WHERE.has(operation)
        ? mergeUniqueWhere((where ?? {}) as Record<string, unknown>, fragment)
        : where === undefined
          ? fragment
          : { AND: [where, fragment] }
      return run({ ...args, where: merged })
    }

  const stampedHook =
    (operation: CreateOperation): QueryHook =>
    async ({ model, args, query: run }: QueryHookParams): Promise<any> => {
      const type = typeForModel.get(delegateKey(model))
      if (type === undefined || engine.store.isInAuthz()) return run(args)
      const stamp = engine.store.getActiveInsert(type)
      if (!stamp || Object.keys(stamp).length === 0) return run(args)

      const data = (args as { data?: unknown } | null | undefined)?.data
      const stamped = Array.isArray(data)
        ? data.map(row => applyStamp(row as Record<string, unknown>, stamp, type))
        : applyStamp((data ?? {}) as Record<string, unknown>, stamp, type)
      return run({ ...args, data: stamped })
    }

  query['$allModels'] = Object.fromEntries([
    ...[...READ_OPERATIONS, ...WRITE_OPERATIONS].map(operation => [operation, filteredHook(operation)]),
    ...CREATE_OPERATIONS.map(operation => [operation, stampedHook(operation)]),
  ])

  return { name: '@kyrobit/kyroguard', query }
}
