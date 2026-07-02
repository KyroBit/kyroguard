import fp from 'fastify-plugin';
import { storage } from './store.js';
import { syncPolicies } from './sync.js';
import { createDbProxy } from './proxy.js';
import { requirePolicy as _requirePolicy, clearPolicyCache } from './require-policy.js';
import { addExtra } from './store.js';
const rbacPlugin = async (app, opts) => {
    const { db, resources, getSubject, contextExtra, scopes } = opts;
    await syncPolicies(db, resources);
    const proxiedDb = createDbProxy(db, { resources, getSubject, contextExtra, scopes });
    app.addHook('onRequest', async (req) => {
        await new Promise(resolve => storage.run({ subject: { id: '' }, context: '', extraOnce: null }, () => resolve()));
    });
    const rbacOpts = { ...opts, db };
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