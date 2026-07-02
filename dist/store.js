import { AsyncLocalStorage } from 'node:async_hooks';
export const storage = new AsyncLocalStorage();
export function getStore() {
    return storage.getStore();
}
export function setContext(subject, context) {
    const existing = storage.getStore();
    if (existing) {
        existing.subject = subject;
        existing.context = context;
    }
    // store is initialised in the plugin's onRequest hook
}
export function addExtra(extra) {
    const store = storage.getStore();
    if (!store)
        return;
    store.extraOnce = { ...(store.extraOnce ?? {}), ...extra };
}
export function consumeExtra() {
    const store = storage.getStore();
    if (!store?.extraOnce)
        return null;
    const extra = store.extraOnce;
    store.extraOnce = null; // consume once — cleared after the insert
    return extra;
}
//# sourceMappingURL=store.js.map