import { getStore } from './store.js'
import type { FastifyRequest, FastifyReply } from 'fastify'
import type { RbacOptions } from './types.js'
import type { RbacAdapter } from './adapter.js'

const cache = new Map<string, Set<string>>()

export function clearPolicyCache(subjectId?: string): void {
  if (subjectId) cache.delete(subjectId)
  else cache.clear()
}

async function getSubjectPolicies(adapter: RbacAdapter, subjectId: string): Promise<Set<string>> {
  if (cache.has(subjectId)) return cache.get(subjectId)!

  const [groupRows, directRows] = await Promise.all([
    adapter.getSubjectGroupPolicies(subjectId),
    adapter.getSubjectDirectPolicies(subjectId),
  ])

  const set = new Set<string>([
    ...groupRows.map(r => r.name),
    ...directRows.map(r => r.name),
  ])

  cache.set(subjectId, set)
  return set
}

export function requirePolicy(
  policyName:   string,
  options?:     { resource?: (req: FastifyRequest) => Promise<unknown> | unknown },
  rbacOptions?: RbacOptions & { adapter: RbacAdapter },
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!rbacOptions) throw new Error('[rbac] requirePolicy not initialised — register rbacPlugin first.')

    const store = getStore()
    if (!store?.subject?.id) return reply.status(401).send({ message: 'Unauthorized' })

    const subject = store.subject

    if (subject.is_super) return

    const allowed = await getSubjectPolicies(rbacOptions.adapter, subject.id)
    if (!allowed.has(policyName)) {
      return reply.status(403).send({ message: 'Forbidden' })
    }
  }
}
