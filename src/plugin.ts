import fp                     from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { storage }            from './store.js'
import { syncPolicies }       from './sync.js'
import { createDbProxy }      from './proxy.js'
import { requirePolicy as _requirePolicy, clearPolicyCache } from './require-policy.js'
import { addExtra }           from './store.js'
import type { RbacOptions }   from './types.js'
import type { FastifyRequest } from 'fastify'

export interface RbacPluginOptions extends RbacOptions {
  db:                   any
  policyGroupIdField?:  string  // field on JWT payload that holds policy_group_id, default 'pgid'
}

const rbacPlugin: FastifyPluginAsync<RbacPluginOptions> = async (app, opts) => {
  const { db, resources, getSubject, contextExtra, scopes, policyGroupIdField = 'pgid' } = opts

  // Sync policies to DB on startup
  await syncPolicies(db, resources)

  // Wrap db with proxy — auto-scope selects, auto-track inserts
  const proxiedDb = createDbProxy(db, { resources, getSubject, contextExtra, scopes })

  // Per-request: initialise AsyncLocalStorage store
  app.addHook('onRequest', async (req, reply) => {
    await new Promise<void>(resolve =>
      storage.run(
        { subject: { id: '' }, context: '', extraOnce: null },
        () => resolve(),
      )
    )
  })

  // Resolve policyGroupId from JWT for requirePolicy
  async function policyGroupIdFromReq(req: FastifyRequest): Promise<string | null> {
    const payload = (req as any).user as Record<string, string> | undefined
    if (!payload?.sub) return null
    // policy_group_id stored in JWT or look up from DB
    return payload[policyGroupIdField] ?? null
  }

  const rbacOpts = { ...opts, db, policyGroupIdFromReq }

  // Decorate app
  app.decorate('rbac', {
    db:               proxiedDb,
    setContext:       (req: FastifyRequest, context: string) => {
      const store = storage.getStore()
      if (!store) return
      store.subject = getSubject(req)
      store.context = context
    },
    addExtra,
    clearPolicyCache,
    requirePolicy:    (policyName: string, options?: { resource?: (req: FastifyRequest) => unknown }) =>
                        _requirePolicy(policyName, options, rbacOpts),
  })
}

export default fp(rbacPlugin, { name: '@kyrobit/rbac', fastify: '5' })

declare module 'fastify' {
  interface FastifyInstance {
    rbac: {
      db:               any
      setContext:       (req: FastifyRequest, context: string) => void
      addExtra:         (extra: Record<string, unknown>) => void
      clearPolicyCache: (policyGroupId?: string) => void
      requirePolicy:    (policyName: string, options?: { resource?: (req: FastifyRequest) => unknown }) => (req: FastifyRequest, reply: any) => Promise<void>
    }
  }
}
