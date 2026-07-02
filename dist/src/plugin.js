import fp from 'fastify-plugin';
import { storage } from './store.js';
import { syncPolicies } from './sync.js';
import { createDbProxy } from './proxy.js';
import { requirePolicy as _requirePolicy, clearPolicyCache } from './require-policy.js';
import { addExtra } from './store.js';
const rbacPlugin = async (app, opts) => {
    const { db, resources, getSubject, contextExtra, scopes, policyGroupIdField = 'pgid' } = opts;
    // Sync policies to DB on startup
    await syncPolicies(db, resources);
    // Wrap db with proxy — auto-scope selects, auto-track inserts
    const proxiedDb = createDbProxy(db, { resources, getSubject, contextExtra, scopes });
    // Per-request: initialise AsyncLocalStorage store
    app.addHook('onRequest', async (req, reply) => {
        await new Promise(resolve => storage.run({ subject: { id: '' }, context: '', extraOnce: null }, () => resolve()));
    });
    // Resolve policyGroupId from JWT for requirePolicy
    async function policyGroupIdFromReq(req) {
        const payload = req.user;
        if (!payload?.sub)
            return null;
        // policy_group_id stored in JWT or look up from DB
        return payload[policyGroupIdField] ?? null;
    }
    const rbacOpts = { ...opts, db, policyGroupIdFromReq };
    // Decorate app
    app.decorate('rbac', {
        db: proxiedDb,
        setContext: (req, context) => {
            const store = storage.getStore();
            if (!store)
                return;
            store.subject = getSubject(req);
            store.context = context;
        },
        addExtra,
        clearPolicyCache,
        requirePolicy: (policyName, options) => _requirePolicy(policyName, options, rbacOpts),
    });
};
export default fp(rbacPlugin, { name: '@kyrobit/rbac', fastify: '5' });
//# sourceMappingURL=plugin.js.map