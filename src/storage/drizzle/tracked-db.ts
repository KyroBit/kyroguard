import { and, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { MisconfiguredError } from '../../core/errors.js'
import type { RbacEngine } from '../../core/engine.js'
import type { ResourceDefinition } from '../../core/policy.js'
import type { Subject } from '../../core/types.js'
import type { OwnershipEntry, StorageAdapter } from '../contract.js'
import type { DrizzleStorageAdapter } from './adapter.js'

/** Builds a per-request drizzle condition; return undefined to skip scoping. */
export type QueryScopeFn = (subject: Subject, db: unknown) => unknown

export interface TrackedDbOptions {
  rbac: {
    engine: RbacEngine
    adapter: StorageAdapter
  }
  resources: ResourceDefinition[]
  /**
   * scope name → condition builder. Query scoping activates for a select on a
   * registered resource when the resource's `context` config — keyed by the
   * SUBJECT'S PORTAL (`resource.context[subject.portal ?? '']` maps
   * policy name → [scope names]) — names scopes present here. ALL matching
   * conditions are OR-combined, then AND-ed into the user's where().
   */
  queryScopes?: Record<string, QueryScopeFn>
  /**
   * What to do when an insert on a registered resource yields no trackable
   * ids (no ids in values() and no .returning()): 'warn' logs once per
   * resource (default), 'error' rejects with MisconfiguredError, 'off' skips.
   */
  strictTracking?: 'warn' | 'error' | 'off'
}

interface Ctx {
  engine: RbacEngine
  adapter: StorageAdapter
  tableMap: Map<unknown, ResourceDefinition>
  queryScopes: Record<string, QueryScopeFn> | undefined
  strictTracking: 'warn' | 'error' | 'off'
  warned: Set<string>
}

interface InsertTracking {
  resourceType: string
  engine: RbacEngine
  write: (entries: OwnershipEntry[]) => Promise<void>
  strictTracking: 'warn' | 'error' | 'off'
  warned: Set<string>
}

const EXEC_METHODS = new Set(['execute', 'run', 'all', 'get'])

const OWNERSHIP_KEYS = ['resourceType', 'resourceId', 'ownerId', 'contextType', 'contextId'] as const

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
      `[rbac] Cannot track ownership for "${t.resourceType}": no ids in values() and no .returning() — add .returning() or use db.untracked.`,
    )
  }
  if (t.warned.has(t.resourceType)) return
  t.warned.add(t.resourceType)
  console.warn(
    `[rbac] Ownership not tracked for "${t.resourceType}": no ids in values() and no .returning(). Add .returning(), pass ids in values(), or use db.untracked to silence.`,
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
      contextType: subject.portal ?? '',
      contextId: subject.context_id ?? '',
      ...overrides,
    })),
  )
}

function wrapInsertChain(builder: any, t: InsertTracking, valueIds: string[] | null, hasReturning: boolean): any {
  const executeTracked = async (run: () => Promise<unknown>): Promise<unknown> => {
    const subject = t.engine.store.getSubject()
    // No subject (seeders, CLI, jobs): plain insert, nothing to attribute.
    if (!subject?.id) return run()
    if (valueIds) {
      const result = await run()
      // Awaited BEFORE the caller's promise resolves; a failed ownership
      // write must reject, never hang or vanish (v0 regression).
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

function wrapScopedFrom(builder: any, scope: SQL): any {
  let memoized: Promise<unknown> | undefined
  const executeScoped = () => (memoized ??= Promise.resolve(builder.where(scope)))

  return new Proxy(builder, {
    get(target, prop) {
      if (prop === 'where') {
        // Scope applied here; the returned builder needs no further wrapping.
        return (condition?: unknown) =>
          target.where(condition === undefined ? scope : and(condition as SQL, scope))
      }
      if (prop === 'then') {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          executeScoped().then(onFulfilled, onRejected)
      }
      if (prop === 'catch') return (onRejected?: (e: unknown) => unknown) => executeScoped().catch(onRejected)
      if (prop === 'finally') return (onFinally?: () => void) => executeScoped().finally(onFinally)
      if (typeof prop === 'string' && EXEC_METHODS.has(prop)) {
        const fn = target[prop]
        if (typeof fn !== 'function') return fn
        return (...args: unknown[]) => {
          const scoped = target.where(scope)
          return scoped[prop](...args)
        }
      }
      const value = target[prop]
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const result = value.apply(target, args)
        // Chained builder methods (limit/orderBy/joins/...) must keep the scope.
        return isQueryBuilder(result) ? wrapScopedFrom(result, scope) : result
      }
    },
  })
}

function buildScopeSql(ctx: Ctx, raw: unknown, table: unknown): SQL | null {
  if (!ctx.queryScopes) return null
  const resource = ctx.tableMap.get(table)
  if (!resource?.context) return null
  const subject = ctx.engine.store.getSubject()
  if (!subject?.id) return null
  const contextPolicies = resource.context[subject.portal ?? '']
  if (!contextPolicies) return null

  const scopeNames = [...new Set(Object.values(contextPolicies).flat())]
  const conditions: SQL[] = []
  for (const name of scopeNames) {
    const build = ctx.queryScopes[name]
    if (!build) continue
    const condition = build(subject, raw)
    if (condition) conditions.push(condition as SQL)
  }
  if (!conditions.length) return null
  if (conditions.length === 1) return conditions[0]!
  return or(...conditions) ?? null
}

function wrapSelectBuilder(builder: any, ctx: Ctx, raw: unknown): any {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === 'from') {
        return (table: unknown, ...rest: unknown[]) => {
          const fromBuilder = target.from(table, ...rest)
          const scope = buildScopeSql(ctx, raw, table)
          return scope ? wrapScopedFrom(fromBuilder, scope) : fromBuilder
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
    // Writing through `raw` (this db or this transaction) keeps ownership
    // rows atomic with the resource insert inside transactions.
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
        return (...args: unknown[]) => wrapSelectBuilder(target[prop](...args), ctx, target)
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
 * Wraps a drizzle database so that:
 * - inserts into registered resource tables record ownership rows
 *   (atomically with the insert inside transactions),
 * - selects on registered resources get portal-configured query scoping,
 * - `db.untracked` exposes the raw handle.
 * update/delete are intentionally not intercepted.
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
    queryScopes: options.queryScopes,
    strictTracking: options.strictTracking ?? 'warn',
    warned: new Set<string>(),
  })
}
