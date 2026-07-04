export declare function assignGroup(db: any, subjectId: string, groupId: string, options?: {
    contextId?: string;
}): Promise<void>;
export declare function removeGroup(db: any, subjectId: string, groupId: string, options?: {
    contextId?: string;
}): Promise<void>;
export declare function assignPolicy(db: any, subjectId: string, policyName: string, options?: {
    scope?: string | null;
}): Promise<void>;
export declare function removePolicy(db: any, subjectId: string, policyName: string): Promise<void>;
//# sourceMappingURL=assign.d.ts.map