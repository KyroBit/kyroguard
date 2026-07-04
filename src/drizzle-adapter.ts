import { eq, inArray, and } from 'drizzle-orm'
import { policies, policyGroups, policyGroupPolicies, userPolicyGroups, userPolicies } from './schema.js'
import type { RbacAdapter, PolicyRow, PolicyRecord, GroupPolicyRecord, GroupPolicyInsert } from './adapter.js'

export function createDrizzleAdapter(db: any): RbacAdapter {
  return {
    async upsertPolicies(rows: PolicyRow[]): Promise<void> {
      await db
        .insert(policies)
        .values(rows.map(r => ({ name: r.name, label: r.label, scope_options: r.scopeOptions, depends_on: r.depends_on })))
        .onConflictDoUpdate({
          target: policies.name,
          set: { label: policies.label, scope_options: policies.scope_options, depends_on: policies.depends_on, updated_at: new Date() },
        })
    },

    async listAllPolicies(): Promise<PolicyRecord[]> {
      return db.select({ id: policies.id, name: policies.name, depends_on: policies.depends_on }).from(policies)
    },

    async deleteGroupPolicies(policyIds: string[]): Promise<void> {
      await db.delete(policyGroupPolicies).where(inArray(policyGroupPolicies.policy_id, policyIds))
    },

    async deleteUserPolicies(policyIds: string[]): Promise<void> {
      await db.delete(userPolicies).where(inArray(userPolicies.policy_id, policyIds))
    },

    async deletePolicies(ids: string[]): Promise<void> {
      await db.delete(policies).where(inArray(policies.id, ids))
    },

    async listGroups(): Promise<{ id: string }[]> {
      return db.select({ id: policyGroups.id }).from(policyGroups)
    },

    async getGroupPolicies(groupId: string): Promise<GroupPolicyRecord[]> {
      return db
        .select({ policy_id: policyGroupPolicies.policy_id })
        .from(policyGroupPolicies)
        .where(eq(policyGroupPolicies.policy_group_id, groupId))
    },

    async insertGroupPolicies(rows: GroupPolicyInsert[]): Promise<void> {
      await db.insert(policyGroupPolicies).values(rows)
    },

    async getSubjectGroupPolicies(subjectId: string, portal?: string | null, contextId?: string | null): Promise<{ name: string; scope: string | null }[]> {
      const { isNull } = await import('drizzle-orm')
      const portalFilter  = portal    ? eq(userPolicyGroups.portal,     portal)    : isNull(userPolicyGroups.portal)
      const contextFilter = contextId ? eq(userPolicyGroups.context_id, contextId) : isNull(userPolicyGroups.context_id)

      return db
        .select({ name: policies.name, scope: policyGroupPolicies.scope })
        .from(userPolicyGroups)
        .innerJoin(policyGroups,        eq(userPolicyGroups.policy_group_id, policyGroups.id))
        .innerJoin(policyGroupPolicies, eq(policyGroupPolicies.policy_group_id, policyGroups.id))
        .innerJoin(policies,            eq(policyGroupPolicies.policy_id, policies.id))
        .where(and(eq(userPolicyGroups.subject_id, subjectId), portalFilter, contextFilter))
    },

    async getSubjectDirectPolicies(subjectId: string): Promise<{ name: string; scope: string | null }[]> {
      return db
        .select({ name: policies.name, scope: userPolicies.scope })
        .from(userPolicies)
        .innerJoin(policies, eq(userPolicies.policy_id, policies.id))
        .where(eq(userPolicies.subject_id, subjectId))
    },

  }
}
