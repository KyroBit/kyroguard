import fp                     from 'fastify-plugin'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { storage, addExtra }  from './store.js'
import { createDbProxy }      from './proxy.js'
import { requirePolicy as _requirePolicy, clearPolicyCache, type RequirePolicyOptions } from './require-policy.js'
import type { RbacOptions }   from './types.js'
import type { RbacAdapter }   from './adapter.js'

export interface RbacPluginOptions extends RbacOptions {
  adapter: RbacAdapter
  db?:     any
}

const rbacPlugin: FastifyPluginAsync<RbacPluginOptions> = async (app, opts) => {
  const { adapter, db, resources, getSubject, contextExtra, scopes } = opts

  const proxiedDb = db ? createDbProxy(db, { resources, getSubject, contextExtra, scopes }, adapter) : null

  app.addHook('onRequest', async () => {
    await new Promise<void>(resolve =>
      storage.run({ subject: { id: '' }, context: '', extraOnce: null }, () => resolve())
    )
  })

  const rbacOpts = { ...opts, adapter }

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

    requirePolicy: (policyName: string, options?: RequirePolicyOptions) =>
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
      requirePolicy:    (policyName: string, options?: RequirePolicyOptions) => (req: FastifyRequest, reply: any) => Promise<void>
    }
  }
}
