import { getStore } from './store.js';
// policy name → scope (null = unrestricted, string = restricted to that scope)
const cache = new Map();
export function clearPolicyCache(subjectId) {
    if (subjectId)
        cache.delete(subjectId);
    else
        cache.clear();
}
async function getSubjectPolicyMap(adapter, subjectId) {
    if (cache.has(subjectId))
        return cache.get(subjectId);
    const [groupRows, directRows] = await Promise.all([
        adapter.getSubjectGroupPolicies(subjectId),
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
    cache.set(subjectId, map);
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
        const policyMap = await getSubjectPolicyMap(rbacOptions.adapter, subject.id);
        if (!policyMap.has(policyName)) {
            return reply.status(403).send({ message: 'Forbidden' });
        }
        const scope = policyMap.get(policyName);
        if (scope !== null && options?.resource) {
            const resource = await options.resource(req);
            if (!resource)
                return reply.status(404).send({ message: 'Not found' });
            const owns = await rbacOptions.adapter.isResourceOwner(subject.id, resource.type, resource.id);
            if (!owns)
                return reply.status(403).send({ message: 'Forbidden' });
        }
    };
}
//# sourceMappingURL=require-policy.js.map