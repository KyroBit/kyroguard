import { and, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { MisconfiguredError } from '../../core/errors.js'
import type { KyroguardEngine } from '../../core/engine.js'
import type { ResourceDefinition } from '../../core/policy.js'
import type { Subject } from '../../core/types.js'
import type { OwnershipEntry, StorageAdapter } from '../contract.js'
import type { DrizzleStorageAdapter } from './adapter.js'

export interface TrackedDbOptions {
  rbac: {
    engine: KyroguardEngine
    adapter: StorageAdapter
  }
  resources: ResourceDefinition[]
  /** Behavior when an insert yields no trackable ids: 'warn' (default) | 'error' | 'off'. */
  strictTracking?: 'warn' | 'error' | 'off'
}

interface Ctx {
  engine: KyroguardEngine
  adapter: StorageAdapter
  tableMap: Map<unknown, ResourceDefinition>
  strictTracking: 'warn' | 'error' | 'off'
  warned: Set<string>
}

interface InsertTracking {
  resourceType: string
  engine: KyroguardEngine
  write: (entries: OwnershipEntry[]) => Promise<void>
  strictTracking: 'warn' | 'error' | 'off'
  warned: Set<string>
}

const EXEC_METHODS = new Set(['execute', 'run', 'all', 'get'])

const OWNERSHIP_KEYS = ['resourceType', 'resourceId', 'ownerId', 'domain', 'tenantId'] as const

// Drizzle builders (any dialect) implement getSQL(); resolved results do not.
function isQueryBuilder(value: unknown): value is Record<string | symbol, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getSQL?: unknown }).getSQL === 'function'
  )
}

function idsFromValues(data: unknown): string[] | null {
  const rows = Array.isArray(data) ? data : [data]
  if (!rows.length) return null
  const ids: string[] = []
  for (const row of rows) {
    const id = (row as Record<string, unknown> | null | undefined)?.['id']
    if (typeof id !== 'string' && typeof id !== 'number') return null
    ids.push(String(id))
  }
  return ids
}

function idsFromRows(result: unknown): string[] {
  if (!Array.isArray(result)) return []
  const ids: string[] = []
  for (const row of result) {
    const id = (row as Record<string, unknown> | null | undefined)?.['id']
    if (typeof id === 'string' || typeof id === 'number') ids.push(String(id))
  }
  return ids
}

function reportUntracked(t: InsertTracking): void {
  if (t.strictTracking === 'off') return
  if (t.strictTracking === 'error') {
    throw new MisconfiguredError(
      `[kyroguard] Cannot track ownership for "${t.resourceType}": no ids in values() and no .returning() — add .returning() or use db.untracked.`,
    )
  }
  if (t.warned.has(t.resourceType)) return
  t.warned.add(t.resourceType)
  console.warn(
    `[kyroguard] Ownership not tracked for "${t.resourceType}": no ids in values() and no .returning(). Add .returning(), pass ids in values(), or use db.untracked to silence.`,
  )
}

async function recordFor(t: InsertTracking, subject: Subject, ids: string[]): Promise<void> {
  const extra = t.engine.store.consumeExtra()
  const overrides: Partial<Record<(typeof OWNERSHIP_KEYS)[number], string>> = {}
  if (extra) {
    for (const key of OWNERSHIP_KEYS) {
      const value = extra[key]
      if (typeof value === 'string') overrides[key] = value
    }
  }
  await t.write(
    ids.map(id => ({
      resourceType: t.resourceType,
      resourceId: id,
      ownerId: subject.id,
      domain: subject.domain ?? '',
      tenantId: subject.tenant_id ?? '',
      ...overrides,
    })),
  )
}

function wrapInsertChain(builder: any, t: InsertTracking, valueIds: string[] | null, hasReturning: boolean): any {
  const executeTracked = async (run: () => Promise<unknown>): Promise<unknown> => {
    const subject = t.engine.store.getSubject()
    if (!subject?.id) return run()
    if (valueIds) {
      const result = await run()
      await recordFor(t, subject, valueIds)
      return result
    }
    if (hasReturning) {
      const result = await run()
      const ids = idsFromRows(result)
      if (ids.length) await recordFor(t, subject, ids)
      else reportUntracked(t)
      return result
    }
    reportUntracked(t)
    return run()
  }

  let memoized: Promise<unknown> | undefined
  const awaited = () => (memoized ??= executeTracked(() => Promise.resolve(builder)))

  return new Proxy(builder, {
    get(target, prop) {
      if (prop === 'then') {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          awaited().then(onFulfilled, onRejected)
      }
      if (prop === 'catch') return (onRejected?: (e: unknown) => unknown) => awaited().catch(onRejected)
      if (prop === 'finally') return (onFinally?: () => void) => awaited().finally(onFinally)
      if (prop === 'returning' || prop === '$returningId') {
        const fn = target[prop]
        if (typeof fn !== 'function') return fn
        return (...args: unknown[]) => wrapInsertChain(fn.apply(target, args), t, valueIds, true)
      }
      if (typeof prop === 'string' && EXEC_METHODS.has(prop)) {
        const fn = target[prop]
        if (typeof fn !== 'function') return fn
        return (...args: unknown[]) => executeTracked(() => Promise.resolve(fn.apply(target, args)))
      }
      const value = target[prop]
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const result = value.apply(target, args)
        return isQueryBuilder(result) ? wrapInsertChain(result, t, valueIds, hasReturning) : result
      }
    },
  })
}

function wrapInsertBuilder(builder: any, t: InsertTracking): any {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === 'values') {
        return (data: unknown) => wrapInsertChain(target.values(data), t, idsFromValues(data), false)
      }
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

interface FilterChain {
  scope: SQL
  userWhere: SQL | undefined
}

function wrapFilteredFrom(builder: any, chain: FilterChain): any {
  const applied = () =>
    builder.where(chain.userWhere === undefined ? chain.scope : and(chain.userWhere, chain.scope))

  let memoized: Promise<unknown> | undefined
  const executeFiltered = () => (memoized ??= Promise.resolve(applied()))

  return new Proxy(builder, {
    get(target, prop) {
      if (prop === 'where') {
        return (condition?: unknown) => {
          chain.userWhere = condition as SQL | undefined
          return wrapFilteredFrom(target, chain)
        }
      }
      if (prop === 'then') {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          executeFiltered().then(onFulfilled, onRejected)
      }
      if (prop === 'catch') return (onRejected?: (e: unknown) => unknown) => executeFiltered().catch(onRejected)
      if (prop === 'finally') return (onFinally?: () => void) => executeFiltered().finally(onFinally)
      if (typeof prop === 'string' && EXEC_METHODS.has(prop)) {
        const fn = target[prop]
        if (typeof fn !== 'function') return fn
        return (...args: unknown[]) => applied()[prop](...args)
      }
      const value = target[prop]
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const result = value.apply(target, args)
        return isQueryBuilder(result) ? wrapFilteredFrom(result, chain) : result
      }
    },
  })
}

function wrapSelectBuilder(builder: any, ctx: Ctx): any {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === 'from') {
        return (table: unknown, ...rest: unknown[]) => {
          const fromBuilder = target.from(table, ...rest)
          const resource = ctx.tableMap.get(table)
          if (!resource) return fromBuilder
          // Scope checks and filter halves must see the unfiltered table.
          if (ctx.engine.store.isInAuthz()) return fromBuilder
          const filter = ctx.engine.store.getActiveFilter(resource.type)
          if (!filter || filter.kind === 'all') return fromBuilder
          // 'none' must not run unfiltered — fail closed.
          const scope = filter.kind === 'none' ? sql`false` : (filter.where as SQL)
          return wrapFilteredFrom(fromBuilder, { scope, userWhere: undefined })
        }
      }
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function makeDbProxy<T extends object>(raw: T, ctx: Ctx): T & { untracked: T } {
  const write = (entries: OwnershipEntry[]): Promise<void> => {
    const withExecutor = (ctx.adapter as Partial<DrizzleStorageAdapter>).recordOwnershipWith
    // Writing through `raw` keeps ownership rows atomic with the insert inside transactions.
    return typeof withExecutor === 'function'
      ? withExecutor.call(ctx.adapter, raw, entries)
      : ctx.adapter.recordOwnership(entries)
  }

  return new Proxy(raw, {
    get(target: any, prop) {
      if (prop === 'untracked') return target

      if (prop === 'insert') {
        return (table: unknown, ...rest: unknown[]) => {
          const builder = target.insert(table, ...rest)
          const resource = ctx.tableMap.get(table)
          if (!resource) return builder
          return wrapInsertBuilder(builder, {
            resourceType: resource.type,
            engine: ctx.engine,
            write,
            strictTracking: ctx.strictTracking,
            warned: ctx.warned,
          })
        }
      }

      if (prop === 'select' || prop === 'selectDistinct') {
        return (...args: unknown[]) => wrapSelectBuilder(target[prop](...args), ctx)
      }

      if (prop === 'transaction') {
        return (callback: (tx: unknown, ...rest: unknown[]) => unknown, ...args: unknown[]) =>
          target.transaction(
            (tx: object, ...rest: unknown[]) => callback(makeDbProxy(tx, ctx), ...rest),
            ...args,
          )
      }

      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as T & { untracked: T }
}

/**
 * Wraps a drizzle db: inserts on registered tables record ownership, selects
 * on registered tables get the request's guard-activated filter (the store's
 * activeFilters plan) ANDed in, `db.untracked` is the raw handle. update and
 * delete are not intercepted — see docs/reference/drizzle.md.
 */
export function trackedDb<T extends object>(db: T, options: TrackedDbOptions): T & { untracked: T } {
  const tableMap = new Map<unknown, ResourceDefinition>()
  for (const resource of options.resources) {
    if (resource.table != null) tableMap.set(resource.table, resource)
  }
  return makeDbProxy(db, {
    engine: options.rbac.engine,
    adapter: options.rbac.adapter,
    tableMap,
    strictTracking: options.strictTracking ?? 'warn',
    warned: new Set<string>(),
  })
}
