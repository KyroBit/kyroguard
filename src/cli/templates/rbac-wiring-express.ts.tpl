/**
 * RBAC wiring for Express. Finish the TODOs, then call registerRbac from your
 * server bootstrap. Guards forward typed RbacErrors to Express's error
 * pipeline via next(err): 401 unauthenticated, 403 policy/scope denied,
 * 404 resource not found.
 */
import { createRbac } from '@kyrobit/rbac'
import { rbacExpress } from '@kyrobit/rbac/express'
import { resources } from './policies.js'
import type { StorageAdapter } from '@kyrobit/rbac'
import type { Express } from 'express'

export function registerRbac(app: Express, adapter: StorageAdapter) {
  // Reuse your app's adapter/db handle — same construction as rbac.config.ts.
  const rbac = createRbac({ adapter, resources })

  const { context, portal: createPortal, errorHandler } = rbacExpress(rbac)

  // Opens the per-request rbac context. Register BEFORE any portal guard.
  app.use(context())

  const portal = createPortal('{{PORTAL}}', {
    // Resolved lazily at guard time, memoized per request per portal.
    // Return null when the request is unauthenticated → 401.
    getSubject: async req => {
      // TODO: resolve your authenticated user (session, JWT, ...):
      // return { id: req.user.id, context_id: req.user.tenantId }
      return null
    },
  })

  // Route usage:
  //
  // app.get('/posts/:id', portal.requirePolicy('posts.read'), handler)
  //
  // Scoped policies need a resource resolver so row-level scopes can run:
  //
  // app.patch(
  //   '/posts/:id',
  //   portal.requirePolicy('posts.update', {
  //     resource: req => ({ type: 'post', id: req.params.id }),
  //   }),
  //   handler,
  // )

  // Register AFTER your routes so rbac errors become JSON responses:
  app.use(errorHandler())

  return { rbac, portal }
}
