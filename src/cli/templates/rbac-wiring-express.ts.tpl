/**
 * RBAC wiring for Express. Finish the TODOs, then call registerRbac from your
 * server bootstrap. Guards forward typed RbacErrors to Express's error
 * pipeline via next(err): 401 unauthenticated, 403 policy/scope denied,
 * 404 resource not found.
 */
import { createRbac } from '@kyrobit/kyroguard'
import { rbacExpress } from '@kyrobit/kyroguard/express'
import { resources } from './policies.js'
import type { StorageAdapter } from '@kyrobit/kyroguard'
import type { Express } from 'express'

export function registerRbac(app: Express, adapter: StorageAdapter) {
  // Reuse your app's adapter/db handle — same construction as kyroguard.config.ts.
  const rbac = createRbac({ adapter, resources })

  const { context, domain: createDomain, errorHandler } = rbacExpress(rbac)

  // Opens the per-request rbac context. Register BEFORE any domain guard.
  app.use(context())

  const domain = createDomain('{{DOMAIN}}', {
    // Resolved lazily at guard time, memoized per request per domain.
    // Return null when the request is unauthenticated → 401.
    getSubject: async req => {
      // TODO: resolve your authenticated user (session, JWT, ...):
      // return { id: req.user.id, tenant_id: req.user.tenantId }
      return null
    },
  })

  // Route usage:
  //
  // app.get('/posts/:id', domain.requirePolicy('posts.read'), handler)
  //
  // Scoped policies need a resource resolver so row-level scopes can run:
  //
  // app.patch(
  //   '/posts/:id',
  //   domain.requirePolicy('posts.update', {
  //     resource: req => ({ type: 'post', id: req.params.id }),
  //   }),
  //   handler,
  // )

  // Register AFTER your routes so rbac errors become JSON responses:
  app.use(errorHandler())

  return { rbac, domain }
}
