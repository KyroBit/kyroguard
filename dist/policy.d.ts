export declare class Policy {
    readonly name: string;
    readonly dependsOn: string[];
    readonly label: string;
    constructor(name: string, label?: string, dependsOn?: string[]);
}
export interface ResourceDefinition {
    table: unknown;
    type: string;
    policies: Policy[];
    context?: Record<string, ContextPolicies>;
}
export type ContextPolicies = Record<string, string[]>;
export type ScopeCondition = (subject: Subject, db: unknown) => unknown;
export interface Subject {
    id: string;
    is_super?: boolean;
    [key: string]: unknown;
}
//# sourceMappingURL=policy.d.ts.map