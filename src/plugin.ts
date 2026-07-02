import fp                     from 'fastify-plugin'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { storage }            from './store.js'
import { syncPolicies }       from './sync.js'
import { createDbProxy }      from './proxy.js'
import { requirePolicy as _requirePolicy, clearPolicyCache } from './require-policy.js'
import { addExtra }           from './store.js'
import type { RbacOptions }   from './types.js'

export interface RbacPluginOptions extends RbacOptions {
  db: any
}

const rbacPlugin: FastifyPluginAsync<RbacPluginOptions> = async (app, opts) => {
  const { db, resources, getSubject, contextExtra, scopes } = opts

  await syncPolicies(db, resources)

  const proxiedDb = createDbProxy(db, { resources, getSubject, contextExtra, scopes })

  app.addHook('onRequest', async (req) => {
    await new Promise<void>(resolve =>
      storage.run({ subject: { id: '' }, context: '', extraOnce: null }, () => resolve())
    )
  })

  const rbacOpts = { ...opts, db }

  app.decorate('rbac', {
    db: proxiedDb,

    setContext: (req: FastifyRequest, context: string) => {
      const store = storage.getStore()
      if (!store) return
      store.subject = getSubject(req)
      store.context = context
    },

    addExtra,
    clearPolicyCache,

    requirePolicy: (policyName: string, options?: { resource?: (req: FastifyRequest) => unknown }) =>
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
      clearPolicyCache: (subjectId?: string) => void
      requirePolicy:    (policyName: string, options?: { resource?: (req: FastifyRequest) => unknown }) => (req: FastifyRequest, reply: any) => Promise<void>
    }
  }
}
