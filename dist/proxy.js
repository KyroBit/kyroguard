import { and } from 'drizzle-orm';
import { getStore, consumeExtra } from './store.js';
const PENDING_SCOPE = Symbol('pendingScope');
const TRACKED_TABLE = Symbol('trackedTable');
// ─── Select proxy ─────────────────────────────────────────────────────────────
// Wraps the select builder chain so scope condition is injected transparently
function wrapSelectBuilder(builder, scopeSql) {
    if (!scopeSql)
        return builder;
    return new Proxy(builder, {
        get(target, prop) {
            // Consumer calls .where(userCond) — AND with scope
            if (prop === 'where') {
                return (userCond) => {
                    const combined = and(userCond, scopeSql);
                    return wrapSelectBuilder(target.where(combined), null); // scope consumed
                };
            }
            // Query executes — no .where() was called — inject scope now
            if (prop === 'then') {
                return (resolve, reject) => {
                    Promise.resolve(target.where(scopeSql)).then(resolve, reject);
                };
            }
            const value = target[prop];
            if (typeof value === 'function') {
                return (...args) => {
                    const result = value.apply(target, args);
                    // Re-wrap any returned builder so scope stays in the chain
                    if (result && typeof result === 'object' && 'then' in result) {
                        return wrapSelectBuilder(result, scopeSql);
                    }
                    return result;
                };
            }
            return value;
        },
    });
}
// ─── Insert proxy ─────────────────────────────────────────────────────────────
// Intercepts .then() after insert to auto-create resource_owners entry
function wrapInsertBuilder(builder, adapter, table, options) {
    return new Proxy(builder, {
        get(target, prop) {
            if (prop === 'then') {
                return async (resolve, reject) => {
                    try {
                        const rows = await Promise.resolve(target);
                        const store = getStore();
                        if (store && rows) {
                            const resource = options.resources.find(r => r.table === table);
                            if (resource) {
                                const rowArray = Array.isArray(rows) ? rows : [rows];
                                const extra = consumeExtra();
                                const global = options.contextExtra?.(store) ?? {};
                                for (const row of rowArray) {
                                    if (!row?.id)
                                        continue;
                                    const meta = { ...global, ...extra };
                                    await adapter.createResourceOwner({
                                        resource_type: resource.type,
                                        resource_id: String(row.id),
                                        subject_id: store.subject.id ?? null,
                                        context_type: store.context ?? null,
                                        context_id: String(store.subject.branchId ?? store.subject.contextId ?? '') || null,
                                        meta: Object.keys(meta).length ? meta : null,
                                    });
                                }
                            }
                        }
                        resolve(rows);
                    }
                    catch (err) {
                        reject(err);
                    }
                };
            }
            const value = target[prop];
            if (typeof value === 'function') {
                return (...args) => {
                    const result = value.apply(target, args);
                    if (result && typeof result === 'object' && 'then' in result) {
                        return wrapInsertBuilder(result, adapter, table, options);
                    }
                    return result;
                };
            }
            return value;
        },
    });
}
// ─── Main db proxy ─────────────────────────────────────────────────────────────
export function createDbProxy(rawDb, options, adapter) {
    const tableResourceMap = new Map(options.resources.map(r => [r.table, r]));
    return new Proxy(rawDb, {
        get(target, prop) {
            // ── SELECT ──
            if (prop === 'select') {
                return (...args) => {
                    const selectBuilder = target.select(...args);
                    return new Proxy(selectBuilder, {
                        get(sb, sbProp) {
                            if (sbProp === 'from') {
                                return (table) => {
                                    const fromBuilder = sb.from(table);
                                    const store = getStore();
                                    const resource = tableResourceMap.get(table);
                                    let scopeSql = null;
                                    if (store && resource) {
                                        const contextPolicies = resource.context?.[store.context] ?? {};
                                        // Collect all scope names for this context
                                        const scopeNames = [...new Set(Object.values(contextPolicies).flat())];
                                        if (scopeNames.length) {
                                            // For each scope name, get the SQL condition and OR them
                                            const conditions = scopeNames
                                                .map(name => options.scopes?.[name]?.(store.subject, rawDb))
                                                .filter(Boolean);
                                            if (conditions.length === 1)
                                                scopeSql = conditions[0];
                                            else if (conditions.length > 1) {
                                                // Multiple scopes = user has at least one → OR them
                                                scopeSql = conditions.reduce((a, b) => 
                                                // drizzle `or` isn't imported here so use sql template
                                                a);
                                            }
                                        }
                                    }
                                    return wrapSelectBuilder(fromBuilder, scopeSql);
                                };
                            }
                            const v = sb[sbProp];
                            return typeof v === 'function' ? v.bind(sb) : v;
                        },
                    });
                };
            }
            // ── INSERT ──
            if (prop === 'insert') {
                return (table) => {
                    const insertBuilder = target.insert(table);
                    return wrapInsertBuilder(insertBuilder, adapter, table, options);
                };
            }
            // Everything else passes through
            const value = target[prop];
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
//# sourceMappingURL=proxy.js.map