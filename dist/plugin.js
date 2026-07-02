import fp from 'fastify-plugin';
import { storage, addExtra } from './store.js';
import { syncPolicies } from './sync.js';
import { createDbProxy } from './proxy.js';
import { requirePolicy as _requirePolicy, clearPolicyCache } from './require-policy.js';
const rbacPlugin = async (app, opts) => {
    const { adapter, db, resources, getSubject, contextExtra, scopes } = opts;
    await syncPolicies(adapter, resources);
    const proxiedDb = db ? createDbProxy(db, { resources, getSubject, contextExtra, scopes }, adapter) : null;
    app.addHook('onRequest', async () => {
        await new Promise(resolve => storage.run({ subject: { id: '' }, context: '', extraOnce: null }, () => resolve()));
    });
    const rbacOpts = { ...opts, adapter };
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