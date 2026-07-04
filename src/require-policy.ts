import { getStore } from './store.js'
import type { FastifyRequest, FastifyReply } from 'fastify'
import type { RbacOptions, RbacTypes } from './types.js'
import type { RbacAdapter } from './adapter.js'
import type { Scope } from './scope.js'

// Send an error response and hijack the reply so Fastify's wrapThenable
// doesn't try to send a second response after this preHandler resolves.
function sendError(reply: FastifyReply, statusCode: number, message: string): void {
  reply.hijack()
  const body = JSON.stringify({ message })
  reply.raw.statusCode = statusCode
  reply.raw.setHeader('content-type', 'application/json; charset=utf-8')
  reply.raw.setHeader('content-length', Buffer.byteLength(body).toString())
  reply.raw.end(body)
}


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

async function getSubjectPolicyMap(adapter: RbacAdapter, subjectId: string, portal?: string | null, contextId?: string | null): Promise<Map<string, string | null>> {
  const cacheKey = [subjectId, portal, contextId].filter(Boolean).join(':')
  if (cache.has(cacheKey)) return cache.get(cacheKey)!

  const [groupRows, directRows] = await Promise.all([
    adapter.getSubjectGroupPolicies(subjectId, portal, contextId),
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
  policyName:   RbacTypes['PolicyName'],
  options?:     RequirePolicyOptions,
  rbacOptions?: RbacOptions & { adapter: RbacAdapter; scopes?: Scope[]; rawDb?: any },
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!rbacOptions) throw new Error('[rbac] requirePolicy not initialised — register rbacPlugin first.')

    const store = getStore()
    if (!store?.subject?.id) { sendError(reply, 401, 'Unauthorized'); return }

    const subject = store.subject
    if (subject.is_super) return

    const portal       = subject.portal as string | undefined
    const resolvedName = portal ? `${portal}.${policyName}` : policyName
    const policyMap    = await getSubjectPolicyMap(rbacOptions.adapter, subject.id, portal, subject.context_id as string | null)

    if (!policyMap.has(resolvedName)) {
      sendError(reply, 403, 'Forbidden'); return
    }

    const scopeName = policyMap.get(resolvedName)!

    if (scopeName !== null) {
      if (!options?.resource) { sendError(reply, 403, 'Forbidden'); return }

      const scopeObj = findScope(rbacOptions.scopes, scopeName)
      if (!scopeObj) { sendError(reply, 403, 'Forbidden'); return }

      const resource = await options.resource(req)
      if (!resource) { sendError(reply, 404, 'Not found'); return }

      const allowed = await scopeObj.check(subject, resource, rbacOptions.rawDb)
      if (!allowed) { sendError(reply, 403, 'Forbidden'); return }
    }
  }
}

function findScope(scopes: Scope[] | undefined, name: string): Scope | undefined {
  return scopes?.find(s => s.name === name)
}
