import { getStore } from './store.js';
const cache = new Map();
export function clearPolicyCache(subjectId) {
    if (subjectId)
        cache.delete(subjectId);
    else
        cache.clear();
}
async function getSubjectPolicies(adapter, subjectId) {
    if (cache.has(subjectId))
        return cache.get(subjectId);
    const [groupRows, directRows] = await Promise.all([
        adapter.getSubjectGroupPolicies(subjectId),
        adapter.getSubjectDirectPolicies(subjectId),
    ]);
    const set = new Set([
        ...groupRows.map(r => r.name),
        ...directRows.map(r => r.name),
    ]);
    cache.set(subjectId, set);
    return set;
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
        const allowed = await getSubjectPolicies(rbacOptions.adapter, subject.id);
        if (!allowed.has(policyName)) {
            return reply.status(403).send({ message: 'Forbidden' });
        }
    };
}
//# sourceMappingURL=require-policy.js.map