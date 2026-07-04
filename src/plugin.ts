import fp                     from 'fastify-plugin'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { storage, addExtra }  from './store.js'
import { requirePolicy as _requirePolicy, clearPolicyCache, type RequirePolicyOptions } from './require-policy.js'
import { assignGroup as _assignGroup, removeGroup as _removeGroup } from './assign.js'
import { RBAC_SCOPES } from './proxy.js'
import type { RbacOptions, RbacTypes } from './types.js'
import type { RbacAdapter }   from './adapter.js'
import type { Subject }       from './policy.js'

export interface RbacPluginOptions {
  adapter: RbacAdapter
  db?:     any   // raw db — passed to scope check functions; if createTrackedDb, scopes are auto-read
}

type SubjectInput = Omit<Subject, 'portal'> & { context_id?: string }

export interface PortalInstance<P extends string> {
  requirePolicy: (
    policyName: P extends keyof RbacTypes['PortalPolicies']
      ? RbacTypes['PortalPolicies'][P]
      : RbacTypes['PolicyName'],
    options?: RequirePolicyOptions,
  ) => (req: FastifyRequest, reply: any) => Promise<void>
  assignGroup: (userId: string, group: string, options?: { contextId?: string }) => Promise<void>
  removeGroup: (userId: string, group: string, options?: { contextId?: string }) => Promise<void>
}

const rbacPlugin: FastifyPluginAsync<RbacPluginOptions> = async (app, opts) => {
  const { adapter, db } = opts

  const scopes   = (db as any)?.[RBAC_SCOPES] ?? []
  const rbacOpts = { ...opts, adapter, scopes, rawDb: db } as RbacOptions & { adapter: RbacAdapter; scopes: typeof scopes; rawDb?: any }

  app.addHook('onRequest', (_req, _reply, done) => {
    storage.run({ subject: { id: '' }, context: '', extraOnce: null }, done)
  })

  app.decorate('rbac', {
    setSubject: (req: FastifyRequest, subject: Subject & { portal?: RbacTypes['Portal'] }) => {
      const store = storage.getStore()
      if (!store) return
      store.subject = subject
      store.context = (subject.context_id as string) ?? ''
    },

    forPortal: <P extends RbacTypes['Portal']>(
      portal:     P,
      getSubject: (req: FastifyRequest) => SubjectInput | Promise<SubjectInput>,
    ): PortalInstance<P> => {
      app.addHook('onRequest', async (req) => {
        const store = storage.getStore()
        if (!store) return
        const subject = await getSubject(req)
        store.subject = { ...subject, portal } as unknown as Subject
        store.context = subject.context_id ?? ''
      })

      return {
        requirePolicy: (policyName: any, options?: RequirePolicyOptions) =>
          _requirePolicy(policyName, options, rbacOpts),

        assignGroup: (userId, group, options) =>
          _assignGroup(db, userId, group, { portal, contextId: options?.contextId }),

        removeGroup: (userId, group, options) =>
          _removeGroup(db, userId, group, { portal, contextId: options?.contextId }),
      }
    },

    addExtra,
    clearPolicyCache,

    requirePolicy: (policyName: RbacTypes['PolicyName'], options?: RequirePolicyOptions) =>
      _requirePolicy(policyName, options, rbacOpts),
  })
}

export default fp(rbacPlugin, { name: '@kyrobit/rbac', fastify: '5' })

declare module 'fastify' {
  interface FastifyInstance {
    rbac: {
      setSubject:       (req: FastifyRequest, subject: Subject & { portal?: RbacTypes['Portal'] }) => void
      forPortal:        <P extends RbacTypes['Portal']>(
        portal:     P,
        getSubject: (req: FastifyRequest) => SubjectInput | Promise<SubjectInput>,
      ) => PortalInstance<P>
      addExtra:         (extra: Record<string, unknown>) => void
      clearPolicyCache: (subjectId?: string) => void
      requirePolicy:    (policyName: RbacTypes['PolicyName'], options?: RequirePolicyOptions) => (req: FastifyRequest, reply: any) => Promise<void>
    }
  }
}
