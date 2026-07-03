import { getStore } from './store.js'
import type { FastifyRequest, FastifyReply } from 'fastify'
import type { RbacOptions } from './types.js'
import type { RbacAdapter } from './adapter.js'

// policy name → scope (null = unrestricted, string = restricted to that scope)
const cache = new Map<string, Map<string, string | null>>()

export function clearPolicyCache(subjectId?: string): void {
  if (subjectId) {
    for (const key of cache.keys()) {
      if (key === subjectId || key.startsWith(`${subjectId}:`)) cache.delete(key)
    }
  } else {
    cache.clear()
  }
}

async function getSubjectPolicyMap(adapter: RbacAdapter, subjectId: string, contextId?: string | null): Promise<Map<string, string | null>> {
  const cacheKey = contextId ? `${subjectId}:${contextId}` : subjectId
  if (cache.has(cacheKey)) return cache.get(cacheKey)!

  const [groupRows, directRows] = await Promise.all([
    adapter.getSubjectGroupPolicies(subjectId, contextId),
    adapter.getSubjectDirectPolicies(subjectId),
  ])

  const map = new Map<string, string | null>()

  for (const row of [...groupRows, ...directRows]) {
    const existing = map.get(row.name)
    if (existing === undefined) {
      map.set(row.name, row.scope)
    } else if (existing !== null) {
      // null = unrestricted wins over any scope
      map.set(row.name, row.scope === null ? null : existing)
    }
  }

  cache.set(cacheKey, map)
  return map
}

export interface RequirePolicyOptions {
  resource?: (req: FastifyRequest) => Promise<{ type: string; id: string } | null | undefined>
                                   | { type: string; id: string } | null | undefined
}

export function requirePolicy(
  policyName:   string,
  options?:     RequirePolicyOptions,
  rbacOptions?: RbacOptions & { adapter: RbacAdapter },
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!rbacOptions) throw new Error('[rbac] requirePolicy not initialised — register rbacPlugin first.')

    const store = getStore()
    if (!store?.subject?.id) return reply.status(401).send({ message: 'Unauthorized' })

    const subject = store.subject
    if (subject.is_super) return

    const policyMap = await getSubjectPolicyMap(rbacOptions.adapter, subject.id, subject.context_id as string | null)

    if (!policyMap.has(policyName)) {
      return reply.status(403).send({ message: 'Forbidden' })
    }

    const scope = policyMap.get(policyName)!

    if (scope !== null && options?.resource) {
      const resource = await options.resource(req)
      if (!resource) return reply.status(404).send({ message: 'Not found' })

      const owns = await rbacOptions.adapter.isResourceOwner(subject.id, resource.type, resource.id)
      if (!owns) return reply.status(403).send({ message: 'Forbidden' })
    }
  }
}
