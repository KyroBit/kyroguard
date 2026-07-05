import { normalizeSentinel } from '../../core/types.js'
import type { RbacEngine } from '../../core/engine.js'
import type { OwnershipEntry, StorageAdapter } from '../contract.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RbacPrismaResourceRegistration {
  /** The resource type recorded in the ownership store, e.g. 'post'. */
  type: string
  /** The Prisma client delegate key, case-exact (`model BlogPost` → `'blogPost'`). */
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

/** The extension object shape for `client.$extends(...)`; structural — src/ never imports `@prisma/client`. */
export interface RbacPrismaExtension {
  name: string
  query: Record<string, Record<string, QueryHook>>
}

/**
 * Prisma client extension: automatic ownership tracking for registered models.
 * Interception gaps (raw SQL, nested writes, db-generated createMany ids, …)
 * are documented in docs/reference/prisma.md.
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

  return { name: '@kyrobit/rbac', query }
}
