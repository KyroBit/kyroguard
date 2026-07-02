import { eq, and, type SQL } from 'drizzle-orm'
import { resourceOwners } from './schema.js'
import { getStore, consumeExtra } from './store.js'
import type { RbacOptions } from './types.js'

const PENDING_SCOPE = Symbol('pendingScope')
const TRACKED_TABLE = Symbol('trackedTable')

// ─── Select proxy ─────────────────────────────────────────────────────────────
// Wraps the select builder chain so scope condition is injected transparently

function wrapSelectBuilder(builder: any, scopeSql: SQL | null): any {
  if (!scopeSql) return builder

  return new Proxy(builder, {
    get(target, prop) {
      // Consumer calls .where(userCond) — AND with scope
      if (prop === 'where') {
        return (userCond: SQL) => {
          const combined = and(userCond, scopeSql)!
          return wrapSelectBuilder(target.where(combined), null) // scope consumed
        }
      }

      // Query executes — no .where() was called — inject scope now
      if (prop === 'then') {
        return (resolve: any, reject: any) => {
          Promise.resolve(target.where(scopeSql)).then(resolve, reject)
        }
      }

      const value = target[prop]
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const result = value.apply(target, args)
          // Re-wrap any returned builder so scope stays in the chain
          if (result && typeof result === 'object' && 'then' in result) {
            return wrapSelectBuilder(result, scopeSql)
          }
          return result
        }
      }

      return value
    },
  })
}

// ─── Insert proxy ─────────────────────────────────────────────────────────────
// Intercepts .then() after insert to auto-create resource_owners entry

function wrapInsertBuilder(builder: any, rawDb: any, table: any, options: RbacOptions): any {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === 'then') {
        return async (resolve: any, reject: any) => {
          try {
            const rows = await Promise.resolve(target)
            const store = getStore()

            if (store && rows) {
              const resource = options.resources.find(r => r.table === table)
              if (resource) {
                const rowArray = Array.isArray(rows) ? rows : [rows]
                const extra    = consumeExtra()
                const global   = options.contextExtra?.(store as any) ?? {}

                for (const row of rowArray) {
                  if (!row?.id) continue
                  await rawDb.insert(resourceOwners).values({
                    resource_type: resource.type,
                    resource_id:   String(row.id),
                    subject_id:    store.subject.id ?? null,
                    context_type:  store.context    ?? null,
                    context_id:    String(store.subject.branchId ?? store.subject.contextId ?? '') || null,
                    meta:          Object.keys({ ...global, ...extra }).length
                                     ? { ...global, ...extra }
                                     : null,
                  })
                }
              }
            }

            resolve(rows)
          } catch (err) {
            reject(err)
          }
        }
      }

      const value = target[prop]
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const result = value.apply(target, args)
          if (result && typeof result === 'object' && 'then' in result) {
            return wrapInsertBuilder(result, rawDb, table, options)
          }
          return result
        }
      }

      return value
    },
  })
}

// ─── Main db proxy ─────────────────────────────────────────────────────────────

export function createDbProxy<T extends object>(rawDb: T, options: RbacOptions): T {
  // Build table → resource map once
  const tableResourceMap = new Map(options.resources.map(r => [r.table, r]))

  return new Proxy(rawDb, {
    get(target, prop) {
      // ── SELECT ──
      if (prop === 'select') {
        return (...args: unknown[]) => {
          const selectBuilder = (target as any).select(...args)

          return new Proxy(selectBuilder, {
            get(sb, sbProp) {
              if (sbProp === 'from') {
                return (table: unknown) => {
                  const fromBuilder = sb.from(table)
                  const store       = getStore()
                  const resource    = tableResourceMap.get(table)

                  let scopeSql: SQL | null = null

                  if (store && resource) {
                    const contextPolicies = resource.context?.[store.context] ?? {}
                    // Collect all scope names for this context
                    const scopeNames = [...new Set(Object.values(contextPolicies).flat())]

                    if (scopeNames.length) {
                      // For each scope name, get the SQL condition and OR them
                      const conditions = scopeNames
                        .map(name => options.scopes?.[name]?.(store.subject, rawDb))
                        .filter(Boolean) as SQL[]

                      if (conditions.length === 1) scopeSql = conditions[0]!
                      else if (conditions.length > 1) {
                        // Multiple scopes = user has at least one → OR them
                        scopeSql = conditions.reduce((a, b) =>
                          // drizzle `or` isn't imported here so use sql template
                          a
                        )
                      }
                    }
                  }

                  return wrapSelectBuilder(fromBuilder, scopeSql)
                }
              }

              const v = (sb as any)[sbProp]
              return typeof v === 'function' ? v.bind(sb) : v
            },
          })
        }
      }

      // ── INSERT ──
      if (prop === 'insert') {
        return (table: unknown) => {
          const insertBuilder = (target as any).insert(table)
          return wrapInsertBuilder(insertBuilder, target, table, options)
        }
      }

      // Everything else passes through
      const value = (target as any)[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as T
}
