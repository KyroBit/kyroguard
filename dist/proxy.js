import { and } from 'drizzle-orm';
import { getStore } from './store.js';
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
// ─── Main db proxy ─────────────────────────────────────────────────────────────
export function createDbProxy(rawDb, options, _adapter) {
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
                                        const scopeNames = [...new Set(Object.values(contextPolicies).flat())];
                                        if (scopeNames.length) {
                                            const conditions = scopeNames
                                                .map(name => options.queryScopes?.[name]?.(store.subject, rawDb))
                                                .filter(Boolean);
                                            if (conditions.length === 1) {
                                                scopeSql = conditions[0];
                                            }
                                            else if (conditions.length > 1) {
                                                scopeSql = conditions[0]; // TODO: OR multiple conditions
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
            // Everything else passes through
            const value = target[prop];
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
//# sourceMappingURL=proxy.js.map