import { normalizeSentinel } from '../../core/types.js'
import type { KyroguardEngine } from '../../core/engine.js'
import type { OwnershipEntry, StorageAdapter } from '../contract.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface KyroguardPrismaResourceRegistration {
  /** The resource type recorded in the ownership store, e.g. 'post'. */
  type: string
  /** The Prisma client delegate key, case-exact (`model BlogPost` → `'blogPost'`). */
  model: string
}

export interface KyroguardPrismaExtensionOptions {
  rbac: {
    engine: KyroguardEngine
    adapter: StorageAdapter
  }
  resources: KyroguardPrismaResourceRegistration[]
}

/** The params Prisma passes to a `query` extension hook (structural subset). */
interface QueryHookParams {
  model: string
  args: any
  query: (args: any) => Promise<any>
}

type QueryHook = (params: QueryHookParams) => Promise<any>

/** The extension object shape for `client.$extends(...)`; structural — src/ never imports `@prisma/client`. */
export interface KyroguardPrismaExtension {
  name: string
  query: Record<string, Record<string, QueryHook>>
}

type ReadOperation = 'findMany' | 'findFirst' | 'findUnique' | 'count'

const READ_OPERATIONS: ReadOperation[] = ['findMany', 'findFirst', 'findUnique', 'count']

// Prisma hands query hooks the schema model name ('BlogPost') while
// registrations carry the delegate key ('blogPost') — normalize both.
function delegateKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1)
}

// findUnique's WhereUniqueInput requires the unique selector at the TOP level,
// so the rbac fragment may only ride AND — never wrap the whole where.
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
export function kyroguardPrismaExtension(options: KyroguardPrismaExtensionOptions): KyroguardPrismaExtension {
  const { engine, adapter } = options.rbac

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
    const readHook =
      (operation: ReadOperation): QueryHook =>
      async ({ model, args, query: run }: QueryHookParams): Promise<any> => {
        const type = typeForModel.get(delegateKey(model))
        if (type === undefined) return run(args)
        // Scope checks and filter builders must see the unfiltered table —
        // the isInAuthz contract (core/engine.ts).
        if (engine.store.isInAuthz()) return run(args)
        const filter = engine.store.getActiveFilter(type)
        if (!filter || filter.kind === 'all') return run(args)
        if (filter.kind === 'none') {
          return operation === 'findMany' ? [] : operation === 'count' ? 0 : null
        }

        const where: unknown = (args as { where?: unknown } | null | undefined)?.where
        const merged =
          operation === 'findUnique'
            ? mergeUniqueWhere((where ?? {}) as Record<string, unknown>, filter.where)
            : where === undefined
              ? filter.where
              : { AND: [where, filter.where] }
        return run({ ...args, where: merged })
      }

    query['$allModels'] = Object.fromEntries(
      READ_OPERATIONS.map(operation => [operation, readHook(operation)]),
    )
  }

  return { name: '@kyrobit/kyroguard', query }
}
