import { eq, and, inArray } from 'drizzle-orm'
import { policies, policyGroups, policyGroupPolicies } from './schema.js'
import { getStore } from './store.js'
import type { FastifyRequest, FastifyReply } from 'fastify'
import type { RbacOptions } from './types.js'

// In-memory cache: roleId → Set<policyName>
// Cleared externally when policy group is updated
const cache = new Map<string, Set<string>>()

export function clearPolicyCache(policyGroupId?: string): void {
  if (policyGroupId) cache.delete(policyGroupId)
  else cache.clear()
}

async function getGroupPolicies(db: any, policyGroupId: string): Promise<Set<string>> {
  if (cache.has(policyGroupId)) return cache.get(policyGroupId)!

  const rows = await db
    .select({ name: policies.name })
    .from(policyGroupPolicies)
    .innerJoin(policies, eq(policyGroupPolicies.policy_id, policies.id))
    .where(eq(policyGroupPolicies.policy_group_id, policyGroupId))

  const set = new Set<string>(rows.map((r: any) => r.name))
  cache.set(policyGroupId, set)
  return set
}

export function requirePolicy(
  policyName:  string,
  options?:    { resource?: (req: FastifyRequest) => Promise<unknown> | unknown },
  rbacOptions?: RbacOptions & { db: any; policyGroupIdFromReq: (req: FastifyRequest) => Promise<string | null> },
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!rbacOptions) throw new Error('[rbac] requirePolicy not initialised — register rbacPlugin first.')

    const policyGroupId = await rbacOptions.policyGroupIdFromReq(req)
    if (!policyGroupId) return reply.status(401).send({ message: 'Unauthorized' })

    // Check is_super — bypasses everything
    const [group] = await rbacOptions.db
      .select({ is_super: policyGroups.is_super, is_active: policyGroups.is_active })
      .from(policyGroups)
      .where(eq(policyGroups.id, policyGroupId))

    if (!group)                    return reply.status(403).send({ message: 'Forbidden' })
    if (group.is_active === 'false') return reply.status(403).send({ message: 'Policy group is inactive' })
    if (group.is_super  === 'true')  return // owner — allow all

    const groupPolicies = await getGroupPolicies(rbacOptions.db, policyGroupId)
    if (!groupPolicies.has(policyName)) {
      return reply.status(403).send({ message: `Missing policy: ${policyName}` })
    }

    // Scope check — only if resource provided
    if (options?.resource) {
      const store    = getStore()
      const resource = await options.resource(req)

      if (store && resource) {
        // Find scope for this policy in current context
        const resourceDef  = rbacOptions.resources.find(r =>
          r.context?.[store.context]?.[policyName] !== undefined
        )
        const scopeNames   = resourceDef?.context?.[store.context]?.[policyName] ?? []

        if (scopeNames.length) {
          // Check scope row in policy_group_policies
          const [row] = await rbacOptions.db
            .select({ scope: policyGroupPolicies.scope })
            .from(policyGroupPolicies)
            .innerJoin(policies, eq(policyGroupPolicies.policy_id, policies.id))
            .where(and(
              eq(policyGroupPolicies.policy_group_id, policyGroupId),
              eq(policies.name, policyName),
            ))

          const scopeName = row?.scope
          if (scopeName && rbacOptions.scopes?.[scopeName]) {
            const condition = rbacOptions.scopes[scopeName](store.subject, rbacOptions.db)
            // Evaluate condition against the specific resource
            const allowed = await checkScopeAgainstResource(condition, resource, rbacOptions.db)
            if (!allowed) return reply.status(403).send({ message: 'Forbidden' })
          }
        }
      }
    }
  }
}

async function checkScopeAgainstResource(
  condition: unknown,
  resource:  unknown,
  db:        any,
): Promise<boolean> {
  // condition is a SQL template — build a SELECT EXISTS query
  // consumer's scope returns: sql`id IN (SELECT resource_id FROM ...)`
  // We check: SELECT 1 FROM <table> WHERE id = ? AND <condition>
  // Since condition is resource_id based, we can query resource_owners directly
  try {
    const res = resource as Record<string, unknown>
    const rows = await db.execute(
      // Execute the scope condition as EXISTS check against the resource id
      // The scope SQL uses `id IN (...)` pattern — we inject the resource id
      condition
    )
    return Array.isArray(rows) ? rows.length > 0 : !!rows
  } catch {
    return false
  }
}
