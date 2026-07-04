import { getStore } from './store.js';
// policy name → scope (null = unrestricted, string = restricted to that scope)
const cache = new Map();
export function clearPolicyCache(subjectId) {
    if (subjectId) {
        for (const key of cache.keys()) {
            if (key === subjectId || key.startsWith(`${subjectId}:`))
                cache.delete(key);
        }
    }
    else {
        cache.clear();
    }
}
async function getSubjectPolicyMap(adapter, subjectId, portal, contextId) {
    const cacheKey = [subjectId, portal, contextId].filter(Boolean).join(':');
    if (cache.has(cacheKey))
        return cache.get(cacheKey);
    const [groupRows, directRows] = await Promise.all([
        adapter.getSubjectGroupPolicies(subjectId, contextId),
        adapter.getSubjectDirectPolicies(subjectId),
    ]);
    const map = new Map();
    for (const row of [...groupRows, ...directRows]) {
        const existing = map.get(row.name);
        if (existing === undefined) {
            map.set(row.name, row.scope);
        }
        else if (existing !== null) {
            // null = unrestricted wins over any scope
            map.set(row.name, row.scope === null ? null : existing);
        }
    }
    cache.set(cacheKey, map);
    return map;
}
export function requirePolicy(policyName, options, rbacOptions) {
    return async (req, reply) => {
        if (!rbacOptions)
            throw new Error('[rbac] requirePolicy not initialised — register rbacPlugin first.');
        const store = getStore();
        if (!store?.subject?.id)
            return reply.status(401).send({ message: 'Unauthorized' });
        const subject = store.subject;
        if (subject.is_super)
            return;
        const portal = subject.portal;
        const resolvedName = portal ? `${portal}.${policyName}` : policyName;
        const policyMap = await getSubjectPolicyMap(rbacOptions.adapter, subject.id, portal, subject.context_id);
        if (!policyMap.has(resolvedName)) {
            return reply.status(403).send({ message: 'Forbidden' });
        }
        const scopeName = policyMap.get(resolvedName);
        if (scopeName !== null) {
            if (!options?.resource)
                return reply.status(403).send({ message: 'Forbidden' });
            const scopeObj = findScope(rbacOptions.scopes, scopeName);
            if (!scopeObj)
                return reply.status(403).send({ message: 'Forbidden' });
            const resource = await options.resource(req);
            if (!resource)
                return reply.status(404).send({ message: 'Not found' });
            const allowed = await scopeObj.check(subject, resource);
            if (!allowed)
                return reply.status(403).send({ message: 'Forbidden' });
        }
    };
}
function findScope(scopes, name) {
    return scopes?.find(s => s.name === name);
}
//# sourceMappingURL=require-policy.js.map