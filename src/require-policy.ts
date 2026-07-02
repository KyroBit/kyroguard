import { eq, inArray } from 'drizzle-orm'
import { policies, policyGroups, policyGroupPolicies, userPolicyGroups, userPolicies } from './schema.js'
import { getStore } from './store.js'
import type { FastifyRequest, FastifyReply } from 'fastify'
import type { RbacOptions } from './types.js'

// Cache: subjectId → Set<policyName>
// Aggregates across all groups + direct assignments
const cache = new Map<string, Set<string>>()

export function clearPolicyCache(subjectId?: string): void {
  if (subjectId) cache.delete(subjectId)
  else cache.clear()
}

async function getSubjectPolicies(db: any, subjectId: string): Promise<Set<string>> {
  if (cache.has(subjectId)) return cache.get(subjectId)!

  // All group policies across every group the user belongs to
  const groupRows = await db
    .select({ name: policies.name })
    .from(userPolicyGroups)
    .innerJoin(policyGroups,       eq(userPolicyGroups.policy_group_id, policyGroups.id))
    .innerJoin(policyGroupPolicies, eq(policyGroupPolicies.policy_group_id, policyGroups.id))
    .innerJoin(policies,            eq(policyGroupPolicies.policy_id, policies.id))
    .where(eq(userPolicyGroups.subject_id, subjectId))

  // Direct per-user policy assignments
  const directRows = await db
    .select({ name: policies.name })
    .from(userPolicies)
    .innerJoin(policies, eq(userPolicies.policy_id, policies.id))
    .where(eq(userPolicies.subject_id, subjectId))

  const set = new Set<string>([
    ...groupRows.map((r: any) => r.name),
    ...directRows.map((r: any) => r.name),
  ])

  cache.set(subjectId, set)
  return set
}

export function requirePolicy(
  policyName:  string,
  options?:    { resource?: (req: FastifyRequest) => Promise<unknown> | unknown },
  rbacOptions?: RbacOptions & { db: any },
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!rbacOptions) throw new Error('[rbac] requirePolicy not initialised — register rbacPlugin first.')

    const store = getStore()
    if (!store?.subject?.id) return reply.status(401).send({ message: 'Unauthorized' })

    const subject = store.subject

    // 1. is_super on the user — bypass everything
    if (subject.is_super) return

    // 2+3. Check group policies + direct assignments (merged, cached by subject id)
    const allowed = await getSubjectPolicies(rbacOptions.db, subject.id)
    if (!allowed.has(policyName)) {
      return reply.status(403).send({ message: 'Forbidden' })
    }

    // Scope check — only if resource provided
    if (options?.resource) {
      const resource = await options.resource(req)

      if (resource) {
        const resourceDef = rbacOptions.resources.find(r =>
          r.context?.[store.context]?.[policyName] !== undefined
        )
        const scopeNames = resourceDef?.context?.[store.context]?.[policyName] ?? []

        if (scopeNames.length) {
          const [row] = await rbacOptions.db
            .select({ scope: policyGroupPolicies.scope })
            .from(userPolicyGroups)
            .innerJoin(policyGroupPolicies, eq(policyGroupPolicies.policy_group_id, userPolicyGroups.policy_group_id))
            .innerJoin(policies, eq(policyGroupPolicies.policy_id, policies.id))
            .where(eq(userPolicyGroups.subject_id, subject.id))

          const scopeName = row?.scope
          if (scopeName && rbacOptions.scopes?.[scopeName]) {
            const condition = rbacOptions.scopes[scopeName](subject, rbacOptions.db)
            const allowed   = await checkScopeAgainstResource(condition, rbacOptions.db)
            if (!allowed) return reply.status(403).send({ message: 'Forbidden' })
          }
        }
      }
    }
  }
}

async function checkScopeAgainstResource(condition: unknown, db: any): Promise<boolean> {
  try {
    const rows = await db.execute(condition)
    return Array.isArray(rows) ? rows.length > 0 : !!rows
  } catch {
    return false
  }
}
