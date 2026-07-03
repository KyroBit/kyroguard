import { eq, inArray, and } from 'drizzle-orm'
import { policies, policyGroups, policyGroupPolicies, userPolicyGroups, userPolicies, resourceOwners } from './schema.js'
import type { RbacAdapter, PolicyRow, PolicyRecord, GroupPolicyRecord, GroupPolicyInsert, ResourceOwnerRow } from './adapter.js'

export function createDrizzleAdapter(db: any): RbacAdapter {
  return {
    async upsertPolicies(rows: PolicyRow[]): Promise<void> {
      await db
        .insert(policies)
        .values(rows.map(r => ({ name: r.name, label: r.label, depends_on: r.depends_on })))
        .onConflictDoUpdate({
          target: policies.name,
          set: { label: policies.label, depends_on: policies.depends_on, updated_at: new Date() },
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

    async getSubjectGroupPolicies(subjectId: string, contextId?: string | null): Promise<{ name: string; scope: string | null }[]> {
      const { isNull, or } = await import('drizzle-orm')
      const contextFilter = contextId
        ? or(isNull(userPolicyGroups.context_id), eq(userPolicyGroups.context_id, contextId))
        : isNull(userPolicyGroups.context_id)

      return db
        .select({ name: policies.name, scope: policyGroupPolicies.scope })
        .from(userPolicyGroups)
        .innerJoin(policyGroups,        eq(userPolicyGroups.policy_group_id, policyGroups.id))
        .innerJoin(policyGroupPolicies, eq(policyGroupPolicies.policy_group_id, policyGroups.id))
        .innerJoin(policies,            eq(policyGroupPolicies.policy_id, policies.id))
        .where(and(eq(userPolicyGroups.subject_id, subjectId), contextFilter))
    },

    async getSubjectDirectPolicies(subjectId: string): Promise<{ name: string; scope: string | null }[]> {
      return db
        .select({ name: policies.name, scope: userPolicies.scope })
        .from(userPolicies)
        .innerJoin(policies, eq(userPolicies.policy_id, policies.id))
        .where(eq(userPolicies.subject_id, subjectId))
    },

    async isResourceOwner(subjectId: string, resourceType: string, resourceId: string): Promise<boolean> {
      const [row] = await db
        .select({ id: resourceOwners.id })
        .from(resourceOwners)
        .where(and(
          eq(resourceOwners.subject_id,    subjectId),
          eq(resourceOwners.resource_type, resourceType),
          eq(resourceOwners.resource_id,   resourceId),
        ))
        .limit(1)
      return !!row
    },

    async createResourceOwner(row: ResourceOwnerRow): Promise<void> {
      await db.insert(resourceOwners).values(row)
    },
  }
}
