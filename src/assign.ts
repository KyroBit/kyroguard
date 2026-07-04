import { eq, and, isNull } from 'drizzle-orm'
import { userPolicyGroups, userPolicies, policies } from './schema.js'

export async function assignGroup(
  db:        any,
  subjectId: string,
  groupId:   string,
  options?:  { portal?: string; contextId?: string },
): Promise<void> {
  await db.insert(userPolicyGroups).values({
    subject_id:      subjectId,
    policy_group_id: groupId,
    portal:          options?.portal   ?? null,
    context_id:      options?.contextId ?? null,
  })
}

export async function removeGroup(
  db:        any,
  subjectId: string,
  groupId:   string,
  options?:  { portal?: string; contextId?: string },
): Promise<void> {
  await db.delete(userPolicyGroups).where(
    and(
      eq(userPolicyGroups.subject_id,      subjectId),
      eq(userPolicyGroups.policy_group_id, groupId),
      options?.portal
        ? eq(userPolicyGroups.portal, options.portal)
        : isNull(userPolicyGroups.portal),
      options?.contextId
        ? eq(userPolicyGroups.context_id, options.contextId)
        : isNull(userPolicyGroups.context_id),
    )
  )
}

export async function assignPolicy(
  db:         any,
  subjectId:  string,
  policyName: string,
  options?:   { scope?: string | null },
): Promise<void> {
  const [row] = await db
    .select({ id: policies.id })
    .from(policies)
    .where(eq(policies.name, policyName))
    .limit(1)

  if (!row) throw new Error(`[rbac] Policy "${policyName}" not found — did you run rbac sync?`)

  await db.insert(userPolicies).values({
    subject_id: subjectId,
    policy_id:  row.id,
    scope:      options?.scope ?? null,
  })
}

export async function removePolicy(
  db:         any,
  subjectId:  string,
  policyName: string,
): Promise<void> {
  const [row] = await db
    .select({ id: policies.id })
    .from(policies)
    .where(eq(policies.name, policyName))
    .limit(1)

  if (!row) return

  await db.delete(userPolicies).where(
    and(
      eq(userPolicies.subject_id, subjectId),
      eq(userPolicies.policy_id,  row.id),
    )
  )
}
