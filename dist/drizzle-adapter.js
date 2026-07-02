import { eq, inArray } from 'drizzle-orm';
import { policies, policyGroups, policyGroupPolicies, userPolicyGroups, userPolicies, resourceOwners } from './schema.js';
export function createDrizzleAdapter(db) {
    return {
        async upsertPolicies(rows) {
            await db
                .insert(policies)
                .values(rows.map(r => ({ name: r.name, label: r.label, depends_on: r.depends_on })))
                .onConflictDoUpdate({
                target: policies.name,
                set: { label: policies.label, depends_on: policies.depends_on, updated_at: new Date() },
            });
        },
        async listAllPolicies() {
            return db.select({ id: policies.id, name: policies.name, depends_on: policies.depends_on }).from(policies);
        },
        async deleteGroupPolicies(policyIds) {
            await db.delete(policyGroupPolicies).where(inArray(policyGroupPolicies.policy_id, policyIds));
        },
        async deleteUserPolicies(policyIds) {
            await db.delete(userPolicies).where(inArray(userPolicies.policy_id, policyIds));
        },
        async deletePolicies(ids) {
            await db.delete(policies).where(inArray(policies.id, ids));
        },
        async listGroups() {
            return db.select({ id: policyGroups.id }).from(policyGroups);
        },
        async getGroupPolicies(groupId) {
            return db
                .select({ policy_id: policyGroupPolicies.policy_id })
                .from(policyGroupPolicies)
                .where(eq(policyGroupPolicies.policy_group_id, groupId));
        },
        async insertGroupPolicies(rows) {
            await db.insert(policyGroupPolicies).values(rows);
        },
        async getSubjectGroupPolicies(subjectId) {
            return db
                .select({ name: policies.name })
                .from(userPolicyGroups)
                .innerJoin(policyGroups, eq(userPolicyGroups.policy_group_id, policyGroups.id))
                .innerJoin(policyGroupPolicies, eq(policyGroupPolicies.policy_group_id, policyGroups.id))
                .innerJoin(policies, eq(policyGroupPolicies.policy_id, policies.id))
                .where(eq(userPolicyGroups.subject_id, subjectId));
        },
        async getSubjectDirectPolicies(subjectId) {
            return db
                .select({ name: policies.name })
                .from(userPolicies)
                .innerJoin(policies, eq(userPolicies.policy_id, policies.id))
                .where(eq(userPolicies.subject_id, subjectId));
        },
        async createResourceOwner(row) {
            await db.insert(resourceOwners).values(row);
        },
    };
}
//# sourceMappingURL=drizzle-adapter.js.map