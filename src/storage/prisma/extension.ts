import { normalizeSentinel } from '../../core/types.js'
import type { GuardEngine } from '../../core/engine.js'
import type { OwnershipEntry, StorageAdapter } from '../contract.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TrackingResourceRegistration {
  /** The resource type recorded in the ownership store, e.g. 'post'. */
  type: string
  /** The Prisma client delegate key, case-exact (`model BlogPost` → `'blogPost'`). */
  model: string
}

export interface TrackingExtensionOptions {
  guard: {
    engine: GuardEngine
    adapter: StorageAdapter
  }
  resources: TrackingResourceRegistration[]
}

/** The params Prisma passes to a `query` extension hook (structural subset). */
interface QueryHookParams {
  model: string
  args: any
  query: (args: any) => Promise<any>
}

type QueryHook = (params: QueryHookParams) => Promise<any>

/** The extension object shape for `client.$extends(...)`; structural — src/ never imports `@prisma/client`. */
export interface TrackingExtension {
  name: string
  query: Record<string, Record<string, QueryHook>>
}

type ReadOperation = 'findMany' | 'findFirst' | 'findUnique' | 'count'
type WriteOperation = 'updateMany' | 'deleteMany' | 'update' | 'delete'
type FilteredOperation = ReadOperation | WriteOperation

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
 * Prisma client extension: automatic ownership tracking for registered models,
 * plus automatic read filtering (findMany/findFirst/findUnique/count) driven
 * by the request's guard-activated filter (the store's activeFilters plan).
 * Interception gaps (raw SQL, nested writes, db-generated createMany ids, …)
 * are documented in docs/reference/prisma.md.
 */
export function trackingExtension(options: TrackingExtensionOptions): TrackingExtension {
  const { engine, adapter } = options.guard

  const extractId = (value: unknown): string | null => {
    if (typeof value !== 'object' || value === null) return null
    const id = (value as { id?: unknown }).id
    if (typeof id === 'string') return id
    if (typeof id === 'number' || typeof id === 'bigint') return String(id)
    return null
  }

  const recordOwnershipFor = async (type: string, ids: Array<string | null>): Promise<void> => {
    const subject = engine.store.getSubject()
    if (!subject) return
    const domain = normalizeSentinel(subject.domain)
    const tenantId = normalizeSentinel(subject.tenant_id)
    const entries: OwnershipEntry[] = []
    for (const resourceId of ids) {
      if (resourceId === null) continue
      entries.push({ resourceType: type, resourceId, ownerId: subject.id, domain, tenantId })
    }
    if (entries.length > 0) await adapter.recordOwnership(entries)
  }

  const query: Record<string, Record<string, QueryHook>> = {}
  for (const resource of options.resources) {
    query[resource.model] = {
      async create({ args, query: run }: QueryHookParams): Promise<any> {
        const result = await run(args)
        await recordOwnershipFor(resource.type, [extractId(result)])
        return result
      },

      async createMany({ args, query: run }: QueryHookParams): Promise<any> {
        const result = await run(args)
        // createMany returns { count } only — db-generated ids are a documented gap.
        const data: unknown = (args as { data?: unknown } | null | undefined)?.data
        const rows = Array.isArray(data) ? data : data !== undefined && data !== null ? [data] : []
        await recordOwnershipFor(resource.type, rows.map(extractId))
        return result
      },

      async upsert({ args, query: run }: QueryHookParams): Promise<any> {
        const result = await run(args)
        await recordOwnershipFor(resource.type, [extractId(result)])
        return result
      },
    }
  }

  const typeForModel = new Map<string, string>()
  for (const registration of options.resources) {
    typeForModel.set(delegateKey(registration.model), registration.type)
  }

  if (typeForModel.size > 0) {
    const filteredHook =
      (operation: FilteredOperation): QueryHook =>
      async ({ model, args, query: run }: QueryHookParams): Promise<any> => {
        const type = typeForModel.get(delegateKey(model))
        if (type === undefined) return run(args)
        // Scope checks and filter builders must see the unfiltered table —
        // the isInAuthz contract (core/engine.ts).
        if (engine.store.isInAuthz()) return run(args)
        const filter = engine.store.getActiveFilter(type)
        if (!filter || filter.kind === 'all') return run(args)

        if (filter.kind === 'none') {
          if (operation === 'findMany') return []
          if (operation === 'count') return 0
          if (AFFECTS_MANY.has(operation)) return { count: 0 }
          if (operation === 'findFirst' || operation === 'findUnique') return null
        }

        // A closed filter still runs for single writes, so Prisma raises its own
        // not-found rather than this extension inventing a return shape.
        const fragment = filter.kind === 'none' ? { NOT: {} } : filter.where
        const where: unknown = (args as { where?: unknown } | null | undefined)?.where
        const merged = TAKES_UNIQUE_WHERE.has(operation)
          ? mergeUniqueWhere((where ?? {}) as Record<string, unknown>, fragment)
          : where === undefined
            ? fragment
            : { AND: [where, fragment] }
        return run({ ...args, where: merged })
      }

    query['$allModels'] = Object.fromEntries(
      [...READ_OPERATIONS, ...WRITE_OPERATIONS].map(operation => [
        operation,
        filteredHook(operation),
      ]),
    )
  }

  return { name: '@kyrobit/kyroguard', query }
}
