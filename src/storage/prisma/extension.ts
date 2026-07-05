import { normalizeSentinel } from '../../core/types.js'
import type { RbacEngine } from '../../core/engine.js'
import type { OwnershipEntry, StorageAdapter } from '../contract.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RbacPrismaResourceRegistration {
  /** The resource type recorded in the ownership store, e.g. 'post'. */
  type: string
  /**
   * The Prisma CLIENT model property name, case-exact as Prisma reports it —
   * i.e. the delegate key (`model BlogPost` → `'blogPost'`).
   */
  model: string
}

export interface RbacPrismaExtensionOptions {
  rbac: { engine: RbacEngine; adapter: StorageAdapter }
  resources: RbacPrismaResourceRegistration[]
}

/** The params Prisma passes to a `query` extension hook (structural subset). */
interface QueryHookParams {
  args: any
  query: (args: any) => Promise<any>
}

type QueryHook = (params: QueryHookParams) => Promise<any>

/**
 * The plain client-extension object shape accepted by `client.$extends(...)`.
 * Structural on purpose — src/ never imports `@prisma/client`.
 */
export interface RbacPrismaExtension {
  name: string
  query: Record<string, Record<string, QueryHook>>
}

/**
 * Prisma client extension: automatic ownership tracking for registered
 * resource models. Apply with `client.$extends(rbacPrismaExtension({...}))`.
 *
 * For each registered model, after `create` / `createMany` / `upsert` the
 * extension reads the current subject from the engine's request context
 * (AsyncLocalStorage) and records ownership through the adapter:
 *
 * - `create` — records the created row's `id` from the result.
 * - `createMany` — Prisma returns only `{ count }`, so ids CANNOT be read
 *   back: only input rows that carry a client-provided `id` are recorded.
 *   Rows relying on database-generated ids are a DOCUMENTED GAP — record
 *   those explicitly via `rbac.ownership.record()`.
 * - `upsert` — Prisma cannot tell whether the row was created or updated, so
 *   ownership is recorded idempotently either way (recordOwnership is an
 *   upsert on (resourceType, resourceId, ownerId)).
 *
 * Semantics:
 * - No subject in the request context → no ownership is recorded, no error.
 * - The ownership write is AWAITED before the result is returned; a failing
 *   write rejects the caller (the resource row itself is already committed —
 *   Prisma query extensions run outside any implicit transaction).
 * - The create/upsert result must include the `id` field (the default
 *   selection does); a custom `select` omitting `id` records nothing.
 *
 * NOT intercepted — call `rbac.ownership.record()` explicitly for these:
 * - `$executeRaw` / `$queryRaw` / raw SQL of any kind,
 * - nested writes (creating rows through a relation on another model),
 * - `createManyAndReturn`, `updateMany`, and every other operation.
 */
export function rbacPrismaExtension(options: RbacPrismaExtensionOptions): RbacPrismaExtension {
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
        // createMany returns { count } only: record the ids present in the
        // input rows (client-provided ids); db-generated ids are the
        // documented gap above.
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

  return { name: '@kyrobit/rbac', query }
}
