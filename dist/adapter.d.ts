export interface PolicyRow {
    name: string;
    label: string;
    depends_on: string[];
}
export interface PolicyRecord {
    id: string;
    name: string;
    depends_on: string[];
}
export interface GroupPolicyRecord {
    policy_id: string;
}
export interface GroupPolicyInsert {
    policy_group_id: string;
    policy_id: string;
    scope: string | null;
}
export interface ResourceOwnerRow {
    resource_type: string;
    resource_id: string;
    subject_id: string | null;
    context_type: string | null;
    context_id: string | null;
    meta: Record<string, unknown> | null;
}
export interface RbacAdapter {
    upsertPolicies(rows: PolicyRow[]): Promise<void>;
    listAllPolicies(): Promise<PolicyRecord[]>;
    deleteGroupPolicies(policyIds: string[]): Promise<void>;
    deleteUserPolicies(policyIds: string[]): Promise<void>;
    deletePolicies(ids: string[]): Promise<void>;
    listGroups(): Promise<{
        id: string;
    }[]>;
    getGroupPolicies(groupId: string): Promise<GroupPolicyRecord[]>;
    insertGroupPolicies(rows: GroupPolicyInsert[]): Promise<void>;
    getSubjectGroupPolicies(subjectId: string): Promise<{
        name: string;
        scope: string | null;
    }[]>;
    getSubjectDirectPolicies(subjectId: string): Promise<{
        name: string;
        scope: string | null;
    }[]>;
    isResourceOwner(subjectId: string, resourceType: string, resourceId: string): Promise<boolean>;
    createResourceOwner(row: ResourceOwnerRow): Promise<void>;
}
//# sourceMappingURL=adapter.d.ts.map