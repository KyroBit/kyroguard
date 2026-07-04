import { eq, and, isNull } from 'drizzle-orm';
import { userPolicyGroups, userPolicies, policies } from './schema.js';
export async function assignGroup(db, subjectId, groupId, options) {
    await db.insert(userPolicyGroups).values({
        subject_id: subjectId,
        policy_group_id: groupId,
        context_id: options?.contextId ?? null,
    });
}
export async function removeGroup(db, subjectId, groupId, options) {
    await db.delete(userPolicyGroups).where(and(eq(userPolicyGroups.subject_id, subjectId), eq(userPolicyGroups.policy_group_id, groupId), options?.contextId
        ? eq(userPolicyGroups.context_id, options.contextId)
        : isNull(userPolicyGroups.context_id)));
}
export async function assignPolicy(db, subjectId, policyName, options) {
    const [row] = await db
        .select({ id: policies.id })
        .from(policies)
        .where(eq(policies.name, policyName))
        .limit(1);
    if (!row)
        throw new Error(`[rbac] Policy "${policyName}" not found — did you run rbac sync?`);
    await db.insert(userPolicies).values({
        subject_id: subjectId,
        policy_id: row.id,
        scope: options?.scope ?? null,
    });
}
export async function removePolicy(db, subjectId, policyName) {
    const [row] = await db
        .select({ id: policies.id })
        .from(policies)
        .where(eq(policies.name, policyName))
        .limit(1);
    if (!row)
        return;
    await db.delete(userPolicies).where(and(eq(userPolicies.subject_id, subjectId), eq(userPolicies.policy_id, row.id)));
}
//# sourceMappingURL=assign.js.map