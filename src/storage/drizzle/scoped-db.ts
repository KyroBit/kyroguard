import {
  and,
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  is,
  One,
  sql,
} from 'drizzle-orm'
import type { Relation, SQL } from 'drizzle-orm'
import { MisconfiguredError } from '../../core/errors.js'
import type { GuardEngine } from '../../core/engine.js'
import type { ResourceDefinition } from '../../core/policy.js'

export interface ScopedDbOptions {
  /** The guard whose per-request store carries the activated filters. */
  guard: { engine: GuardEngine }
  resources: ResourceDefinition[]
  /** The same schema module passed to `drizzle()`. */
  schema: Record<string, unknown>
  /**
   * Reasons allowed to bypass filtering, e.g. `['seeders', 'jobs/sweep']`.
   * `db.unscoped(reason)` accepts only these, so every bypass is a registered decision
   * rather than a line buried in a handler. Omit it and nothing may bypass.
   */
  unscoped?: readonly string[]
}

interface RelationalConfig {
  relational: Record<string, { relations?: Record<string, Relation> }>
  tables: Record<string, unknown>
}

interface Ctx {
  engine: GuardEngine
  tableMap: Map<unknown, ResourceDefinition>
  unscoped: ReadonlySet<string>
  relationalConfig: RelationalConfig
}

const EXEC_METHODS = new Set(['execute', 'run', 'all', 'get'])

// Drizzle builders (any dialect) implement getSQL(); resolved results do not.
function isQueryBuilder(value: unknown): value is Record<string | symbol, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getSQL?: unknown }).getSQL === 'function'
  )
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
      // Awaiting the builder must behave exactly like awaiting the filtered one.
      if (prop === 'then') {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          executeFiltered().then(onFulfilled, onRejected)
      }
      if (prop === 'catch') {
        return (onRejected?: (e: unknown) => unknown) => executeFiltered().catch(onRejected)
      }
      if (prop === 'finally') {
        return (onFinally?: () => void) => executeFiltered().finally(onFinally)
      }
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
 * The grant's insert columns are the same fact its filter reads by, so a row
 * created with a different value would be invisible to its creator — that is a
 * bug in the caller, not a value to overwrite silently.
 */
function wrapInsert(builder: any, stamp: Record<string, unknown>, resourceType: string): any {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop !== 'values') {
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      }
      return (input: unknown) => {
        const rows = Array.isArray(input) ? input : [input]
        const stamped = rows.map(row => {
          const next = { ...(row as Record<string, unknown>) }
          for (const [column, value] of Object.entries(stamp)) {
            if (next[column] !== undefined && next[column] !== value) {
              throw new MisconfiguredError(
                `[kyroguard] insert into "${resourceType}": the grant sets "${column}" to ` +
                  `${JSON.stringify(value)}, but this insert passes ${JSON.stringify(next[column])} — ` +
                  `the row would be unreadable to whoever created it.`,
              )
            }
            next[column] = value
          }
          return next
        })
        return target.values(Array.isArray(input) ? stamped : stamped[0])
      }
    },
  })
}

function relationalConfigFrom(schema: Record<string, unknown>): RelationalConfig {
  const { tables } = extractTablesRelationalConfig(schema, createTableRelationsHelpers)
  return { relational: tables as RelationalConfig['relational'], tables: schema }
}

/**
 * db.query must filter like db.select. Drizzle exposes `where` on the root config
 * and on `many` relations only, so a `one` relation pointing at a filtered table
 * cannot be narrowed — that fails loudly rather than returning disallowed rows.
 */
function wrapQuery(query: any, ctx: Ctx): any {
  const { relational, tables } = ctx.relationalConfig

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
              `Load it with db.select() and a join, or use db.unscoped(reason).`,
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

function makeDbProxy<T extends object>(raw: T, ctx: Ctx): T & { unscoped: (reason: string) => T } {
  return new Proxy(raw, {
    get(target: any, prop) {
      if (prop === 'unscoped') {
        return (reason?: string) => {
          const registered = [...ctx.unscoped]
          if (typeof reason !== 'string' || reason === '') {
            throw new MisconfiguredError(
              `[kyroguard] db.unscoped(reason) needs a reason registered in ` +
                `scopedDb({ unscoped: [...] }). Registered: ${registered.join(', ') || '(none)'}.`,
            )
          }
          if (!ctx.unscoped.has(reason)) {
            throw new MisconfiguredError(
              `[kyroguard] db.unscoped("${reason}") is not registered — add it to ` +
                `scopedDb({ unscoped: ['${reason}'] }). Registered: ${registered.join(', ') || '(none)'}.`,
            )
          }
          return target
        }
      }

      if (prop === 'query') {
        return wrapQuery(target.query, ctx)
      }

      if (prop === 'select' || prop === 'selectDistinct') {
        return (...args: unknown[]) => wrapSelectBuilder(target[prop](...args), ctx)
      }

      if (prop === 'insert') {
        return (table: unknown, ...rest: unknown[]) => {
          const builder = target.insert(table, ...rest)
          const resource = ctx.tableMap.get(table)
          if (!resource || ctx.engine.store.isInAuthz()) return builder
          const stamp = ctx.engine.store.getActiveInsert(resource.type)
          if (!stamp || Object.keys(stamp).length === 0) return builder
          return wrapInsert(builder, stamp, resource.type)
        }
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
  }) as T & { unscoped: (reason: string) => T }
}

/**
 * Wraps a drizzle db: queries on registered tables get the request's
 * guard-activated filter (the store's activeFilters plan) ANDed in — selects,
 * joins and db.query on the read side, update and delete on the write side.
 * Inserts pass through untouched, and `db.unscoped(reason)` returns the raw
 * handle for a registered reason only — see docs/reference/drizzle.md.
 */
export function scopedDb<T extends object>(db: T, options: ScopedDbOptions): T & { unscoped: (reason: string) => T } {
  const tableMap = new Map<unknown, ResourceDefinition>()
  for (const resource of options.resources) {
    if (resource.table != null) tableMap.set(resource.table, resource)
  }
  return makeDbProxy(db, {
    engine: options.guard.engine,
    tableMap,
    unscoped: new Set(options.unscoped ?? []),
    relationalConfig: relationalConfigFrom(options.schema),
  })
}
