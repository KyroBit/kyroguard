import fp from 'fastify-plugin';
import { storage, addExtra } from './store.js';
import { createDbProxy } from './proxy.js';
import { requirePolicy as _requirePolicy, clearPolicyCache } from './require-policy.js';
const rbacPlugin = async (app, opts) => {
    const { adapter, db, resources, contextExtra } = opts;
    const scopes = resources.flatMap(r => r.scopes ?? []);
    const proxiedDb = db ? createDbProxy(db, { resources, contextExtra }, adapter) : null;
    app.addHook('onRequest', async () => {
        await new Promise(resolve => storage.run({ subject: { id: '' }, context: '', extraOnce: null }, () => resolve()));
    });
    const rbacOpts = { ...opts, adapter, scopes };
    app.decorate('rbac', {
        db: proxiedDb,
        setSubject: (req, subject) => {
            const store = storage.getStore();
            if (!store)
                return;
            store.subject = subject;
            store.context = subject.context_id ?? '';
        },
        forPortal: (portal, getSubject) => {
            app.addHook('onRequest', async (req) => {
                const store = storage.getStore();
                if (!store)
                    return;
                const subject = await getSubject(req);
                store.subject = { ...subject, portal };
                store.context = subject.context_id ?? '';
            });
            return {
                requirePolicy: (policyName, options) => _requirePolicy(policyName, options, rbacOpts),
            };
        },
        addExtra,
        clearPolicyCache,
        requirePolicy: (policyName, options) => _requirePolicy(policyName, options, rbacOpts),
    });
};
export default fp(rbacPlugin, { name: '@kyrobit/rbac', fastify: '5' });
//# sourceMappingURL=plugin.js.map