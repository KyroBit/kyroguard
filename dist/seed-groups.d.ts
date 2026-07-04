import type { Policy } from './policy.js';
export type GroupPoliciesInput = 'all' | string[] | Record<string, string | null>;
export interface GroupDefinition {
    label: string;
    policies: GroupPoliciesInput;
}
export type GroupsDefinition = Record<string, GroupDefinition>;
export declare function seedGroups(db: any, groups: GroupsDefinition, allPolicies?: Policy[]): Promise<void>;
//# sourceMappingURL=seed-groups.d.ts.map