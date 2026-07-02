import type { Subject } from './policy.js';
export interface RbacStore {
    subject: Subject;
    context: string;
    extraOnce: Record<string, unknown> | null;
}
export declare const storage: any;
export declare function getStore(): RbacStore | undefined;
export declare function setContext(subject: Subject, context: string): void;
export declare function addExtra(extra: Record<string, unknown>): void;
export declare function consumeExtra(): Record<string, unknown> | null;
//# sourceMappingURL=store.d.ts.map