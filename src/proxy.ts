import { and, type SQL } from 'drizzle-orm'
import { getStore } from './store.js'
import { resourceOwners } from './schema.js'
import type { ScopeCondition, ResourceDefinition } from './policy.js'

export interface TrackedDbOptions {
  resources:    ResourceDefinition[]
  queryScopes?: Record<string, ScopeCondition>
}

// ─── Select proxy ─────────────────────────────────────────────────────────────

function wrapSelectBuilder(builder: any, scopeSql: SQL | null): any {
  if (!scopeSql) return builder

  return new Proxy(builder, {
    get(target, prop) {
      if (prop === 'where') {
        return (userCond: SQL) => {
          const combined = and(userCond, scopeSql)!
          return wrapSelectBuilder(target.where(combined), null)
        }
      }

      if (prop === 'then') {
        return (resolve: any, reject: any) => {
          Promise.resolve(target.where(scopeSql)).then(resolve, reject)
        }
      }

      const value = target[prop]
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const result = value.apply(target, args)
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

function wrapReturningBuilder(builder: any, resourceType: string, rawDb: any): any {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === 'then') {
        return (resolve: any, reject: any) => {
          Promise.resolve(target).then(async (rows: any[]) => {
            const store = getStore()
            if (store?.subject?.id && rows?.length) {
              const toInsert = rows
                .filter((r: any) => r?.id != null)
                .map((r: any) => ({
                  resource_type: resourceType,
                  resource_id:   String(r.id),
                  owner_id:      store.subject.id,
                  context_type:  (store.subject.portal as string | undefined) ?? null,
                  context_id:    store.context || null,
                }))
              if (toInsert.length) {
                await rawDb.insert(resourceOwners).values(toInsert)
              }
            }
            resolve(rows)
          }, reject)
        }
      }
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

function wrapValuesBuilder(builder: any, resourceType: string, rawDb: any): any {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === 'returning') {
        return (...args: any[]) =>
          wrapReturningBuilder(target.returning(...args), resourceType, rawDb)
      }
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

function wrapInsertBuilder(builder: any, resourceType: string, rawDb: any): any {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === 'values') {
        return (data: any) =>
          wrapValuesBuilder(target.values(data), resourceType, rawDb)
      }
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

// ─── Main tracked db ──────────────────────────────────────────────────────────

export const RBAC_SCOPES = Symbol('rbac.scopes')

export function createTrackedDb<T extends object>(rawDb: T, options: TrackedDbOptions): T & { untracked: T } {
  const tableResourceMap = new Map(options.resources.map(r => [r.table, r]))
  const collectedScopes  = options.resources.flatMap(r => r.policies.flatMap(p => p.scopeOptions))

  const proxy = new Proxy(rawDb, {
    get(target, prop) {
      if (prop === RBAC_SCOPES) return collectedScopes
      if (prop === 'untracked') return target

      // ── INSERT ──
      if (prop === 'insert') {
        return (table: unknown) => {
          const resource = tableResourceMap.get(table)
          const ib = (target as any).insert(table)
          if (!resource) return ib
          return wrapInsertBuilder(ib, resource.type, rawDb)
        }
      }

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
                    const scopeNames = [...new Set(Object.values(contextPolicies).flat())]

                    if (scopeNames.length) {
                      const conditions = scopeNames
                        .map(name => options.queryScopes?.[name]?.(store.subject, rawDb))
                        .filter(Boolean) as SQL[]

                      if (conditions.length) scopeSql = conditions[0]!
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

      const value = (target as any)[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  return proxy as T & { untracked: T }
}

// Internal alias used by the plugin
export { createTrackedDb as createDbProxy }
