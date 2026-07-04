import type { Subject } from './policy.js';
export type ScopeCheckFn = (subject: Subject, resource: {
    type: string;
    id: string;
}) => Promise<boolean> | boolean;
export declare class Scope {
    readonly name: string;
    readonly label: string;
    readonly check: ScopeCheckFn;
    constructor(name: string, label: string, check: ScopeCheckFn);
}
//# sourceMappingURL=scope.d.ts.map