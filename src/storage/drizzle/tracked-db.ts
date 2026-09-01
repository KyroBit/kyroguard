import { and, is, One, sql } from 'drizzle-orm'
import type { Relation, SQL } from 'drizzle-orm'
import { MisconfiguredError } from '../../core/errors.js'
import type { GuardEngine } from '../../core/engine.js'
import type { ResourceDefinition } from '../../core/policy.js'
import type { Subject } from '../../core/types.js'
import type { OwnershipEntry, StorageAdapter } from '../contract.js'
import type { DrizzleStorageAdapter } from './adapter.js'

export interface TrackedDbOptions {
  guard: {
    engine: GuardEngine
    adapter: StorageAdapter
  }
  resources: ResourceDefinition[]
  /** Behavior when an insert yields no trackable ids: 'warn' (default) | 'error' | 'off'. */
  strictTracking?: 'warn' | 'error' | 'off'
  /**
   * Reasons allowed to bypass tracking and filtering, e.g. `['seeders', 'jobs/sweep']`.
   * `db.untracked(reason)` accepts only these, so every bypass is a registered decision
   * rather than a line buried in a handler. Omit it and nothing may bypass.
   */
  untracked?: readonly string[]
}

interface Ctx {
  engine: GuardEngine
  adapter: StorageAdapter
  tableMap: Map<unknown, ResourceDefinition>
  strictTracking: 'warn' | 'error' | 'off'
  untracked: ReadonlySet<string>
  warned: Set<string>
}

interface InsertTracking {
  resourceType: string
  engine: GuardEngine
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


/** Both proxies defer work to a memoized run; awaiting them must behave identically. */
function settle(prop: string | symbol, run: () => Promise<unknown>): unknown {
  if (prop === 'then') {
    return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      run().then(onFulfilled, onRejected)
  }
  if (prop === 'catch') return (onRejected?: (e: unknown) => unknown) => run().catch(onRejected)
  if (prop === 'finally') return (onFinally?: () => void) => run().finally(onFinally)
  return undefined
}

function reportUntracked(t: InsertTracking): void {
  if (t.strictTracking === 'off') return
  if (t.strictTracking === 'error') {
    throw new MisconfiguredError(
      `[kyroguard] Cannot track ownership for "${t.resourceType}": no ids in values() and no .returning() — add .returning() or use db.untracked(reason).`,
    )
  }
  if (t.warned.has(t.resourceType)) return
  t.warned.add(t.resourceType)
  console.warn(
    `[kyroguard] Ownership not tracked for "${t.resourceType}": no ids in values() and no .returning(). Add .returning(), pass ids in values(), or use db.untracked(reason) to silence.`,
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
      const settled = settle(prop, awaited)
      if (settled) return settled
      if (prop === 'returning' || prop === '$returningId') {
        const fn = target[prop]
        if (typeof fn !== 'function') return fn
        return (...args: unknown[]) => wrapInsertChain(fn.apply(target, args), t, valueIds, true)
      }
      // On conflict the statement may write nothing, and the existing row belongs to
      // whoever created it. Only rows confirmed by .returning() may be attributed.
      if (prop === 'onConflictDoNothing' || prop === 'onConflictDoUpdate') {
        const fn = target[prop]
        if (typeof fn !== 'function') return fn
        return (...args: unknown[]) => wrapInsertChain(fn.apply(target, args), t, null, hasReturning)
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
      // insert-from-select: the rows are not in hand, so ids can only come from .returning().
      if (prop === 'select') {
        return (...args: unknown[]) => wrapInsertChain(target.select(...args), t, null, false)
      }
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

interface FilterChain {
  /** The root table's filter, ANDed into the final where. Null when it has none. */
  scope: SQL | null
  userWhere: SQL | undefined
  ctx: Ctx
}

const JOIN_METHODS = new Set(['innerJoin', 'leftJoin', 'rightJoin', 'fullJoin'])

function wrapFilteredFrom(builder: any, chain: FilterChain): any {
  const applied = () => {
    const conditions = [chain.userWhere, chain.scope].filter(Boolean) as SQL[]
    if (!conditions.length) return builder
    return builder.where(conditions.length === 1 ? conditions[0] : and(...conditions))
  }

  let memoized: Promise<unknown> | undefined
  const executeFiltered = () => (memoized ??= Promise.resolve(applied()))

  return new Proxy(builder, {
    get(target, prop) {
      // A registered table carries its filter however it is reached — from() or a join.
      // It goes in the ON condition, so a left join still keeps its left rows.
      if (typeof prop === 'string' && JOIN_METHODS.has(prop)) {
        const fn = target[prop]
        if (typeof fn !== 'function') return fn
        return (table: unknown, on: unknown, ...rest: unknown[]) => {
          const joinScope = activeScopeFor(table, chain.ctx)
          const condition = joinScope && on ? and(on as SQL, joinScope) : (joinScope ?? on)
          const result = fn.apply(target, [table, condition, ...rest])
          return isQueryBuilder(result) ? wrapFilteredFrom(result, chain) : result
        }
      }
      if (prop === 'where') {
        return (condition?: unknown) => {
          chain.userWhere = condition as SQL | undefined
          return wrapFilteredFrom(target, chain)
        }
      }
      const settled = settle(prop, executeFiltered)
      if (settled) return settled
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

/** The active decision for a registered table, or null when the query runs untouched. */
function activeScopeFor(table: unknown, ctx: Ctx): SQL | null {
  const resource = ctx.tableMap.get(table)
  if (!resource) return null
  // Scope checks and filter halves must see the unfiltered table.
  if (ctx.engine.store.isInAuthz()) return null
  const filter = ctx.engine.store.getActiveFilter(resource.type)
  if (!filter || filter.kind === 'all') return null
  // 'none' must not run unfiltered — fail closed.
  return filter.kind === 'none' ? sql`false` : (filter.where as SQL)
}

function wrapSelectBuilder(builder: any, ctx: Ctx): any {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === 'from') {
        return (table: unknown, ...rest: unknown[]) => {
          const fromBuilder = target.from(table, ...rest)
          // Always wrapped: a later join may bring in a registered table even when
          // the root one carries no filter of its own.
          return wrapFilteredFrom(fromBuilder, {
            scope: activeScopeFor(table, ctx),
            userWhere: undefined,
            ctx,
          })
        }
      }
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * db.query must filter like db.select. Drizzle exposes `where` on the root config
 * and on `many` relations only, so a `one` relation pointing at a filtered table
 * cannot be narrowed — that fails loudly rather than returning disallowed rows.
 */
function wrapQuery(query: any, raw: any, ctx: Ctx): any {
  const relational = raw?._?.schema as
    | Record<string, { relations?: Record<string, Relation> }>
    | undefined
  const tables = raw?._?.fullSchema as Record<string, unknown> | undefined
  if (!relational || !tables) return query

  const nameByTable = new Map<unknown, string>()
  for (const key of Object.keys(relational)) nameByTable.set(tables[key], key)

  const scopedConfig = (tsName: string, config: any): any => {
    const scope = activeScopeFor(tables[tsName], ctx)
    const next = { ...(config ?? {}) }

    if (scope) {
      next.where = next.where === undefined ? scope : and(next.where as SQL, scope)
    }

    if (next.with) {
      const relations = relational[tsName]?.relations ?? {}
      const withNext: Record<string, unknown> = {}
      for (const [name, value] of Object.entries(next.with as Record<string, unknown>)) {
        const relation = relations[name]
        if (!relation || value === false || value === undefined) {
          withNext[name] = value
          continue
        }
        const target = relation.referencedTable
        const targetScope = activeScopeFor(target, ctx)
        if (!targetScope) {
          withNext[name] = value
          continue
        }
        if (is(relation, One)) {
          throw new MisconfiguredError(
            `[kyroguard] db.query.${tsName}: relation "${name}" is a one-relation on a filtered ` +
              `resource, and Drizzle exposes no where for it — the rows cannot be narrowed. ` +
              `Load it with db.select() and a join, or use db.untracked(reason).`,
          )
        }
        const nested = value === true ? {} : (value as Record<string, unknown>)
        const relName = nameByTable.get(target)
        withNext[name] = relName ? scopedConfig(relName, nested) : nested
      }
      next.with = withNext
    }

    return next
  }

  return new Proxy(query, {
    get(target, prop) {
      const tableQuery = target[prop]
      if (typeof prop !== 'string' || !tableQuery || typeof tableQuery !== 'object') return tableQuery
      return new Proxy(tableQuery, {
        get(inner: any, method) {
          const fn = inner[method]
          if ((method !== 'findMany' && method !== 'findFirst') || typeof fn !== 'function') {
            return typeof fn === 'function' ? fn.bind(inner) : fn
          }
          return (config?: unknown) => fn.call(inner, scopedConfig(prop, config))
        },
      })
    },
  })
}

function makeDbProxy<T extends object>(raw: T, ctx: Ctx): T & { untracked: (reason: string) => T } {
  const write = (entries: OwnershipEntry[]): Promise<void> => {
    const withExecutor = (ctx.adapter as Partial<DrizzleStorageAdapter>).recordOwnershipWith
    // Writing through `raw` keeps ownership rows atomic with the insert inside transactions.
    return typeof withExecutor === 'function'
      ? withExecutor.call(ctx.adapter, raw, entries)
      : ctx.adapter.recordOwnership(entries)
  }

  return new Proxy(raw, {
    get(target: any, prop) {
      if (prop === 'untracked') {
        return (reason?: string) => {
          const registered = [...ctx.untracked]
          if (typeof reason !== 'string' || reason === '') {
            throw new MisconfiguredError(
              `[kyroguard] db.untracked(reason) needs a reason registered in ` +
                `trackedDb({ untracked: [...] }). Registered: ${registered.join(', ') || '(none)'}.`,
            )
          }
          if (!ctx.untracked.has(reason)) {
            throw new MisconfiguredError(
              `[kyroguard] db.untracked("${reason}") is not registered — add it to ` +
                `trackedDb({ untracked: ['${reason}'] }). Registered: ${registered.join(', ') || '(none)'}.`,
            )
          }
          return target
        }
      }

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

      if (prop === 'query') {
        return wrapQuery(target.query, target, ctx)
      }

      if (prop === 'select' || prop === 'selectDistinct') {
        return (...args: unknown[]) => wrapSelectBuilder(target[prop](...args), ctx)
      }

      // Writes carry the same decision as reads: without this a grant that can only
      // read its own rows could still update or delete every other row.
      if (prop === 'update' || prop === 'delete') {
        return (table: unknown, ...rest: unknown[]) => {
          const builder = target[prop](table, ...rest)
          const scope = activeScopeFor(table, ctx)
          return scope ? wrapFilteredFrom(builder, { scope, userWhere: undefined, ctx }) : builder
        }
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
  }) as T & { untracked: (reason: string) => T }
}

/**
 * Wraps a drizzle db: inserts on registered tables record ownership, selects
 * on registered tables get the request's guard-activated filter (the store's
 * activeFilters plan) ANDed in, and update/delete carry the same filter.
 * and `db.untracked(reason)` returns the raw handle for a registered reason only —
 * see docs/reference/drizzle.md.
 */
export function trackedDb<T extends object>(db: T, options: TrackedDbOptions): T & { untracked: (reason: string) => T } {
  const tableMap = new Map<unknown, ResourceDefinition>()
  for (const resource of options.resources) {
    if (resource.table != null) tableMap.set(resource.table, resource)
  }
  return makeDbProxy(db, {
    engine: options.guard.engine,
    adapter: options.guard.adapter,
    tableMap,
    strictTracking: options.strictTracking ?? 'warn',
    untracked: new Set(options.untracked ?? []),
    warned: new Set<string>(),
  })
}
