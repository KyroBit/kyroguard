/**
 * RBAC wiring for Fastify. Finish the TODOs, then call registerRbac from your
 * server bootstrap. Guards throw typed RbacErrors through Fastify's own error
 * pipeline: 401 unauthenticated, 403 policy/scope denied, 404 resource not
 * found — your error handler and onSend hooks keep working.
 */
import { createRbac } from '@kyrobit/rbac'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { resources } from './policies.js'
import type { StorageAdapter } from '@kyrobit/rbac'
import type { FastifyInstance } from 'fastify'

export async function registerRbac(app: FastifyInstance, adapter: StorageAdapter) {
  // Reuse your app's adapter/db handle — same construction as rbac.config.ts.
  const rbac = createRbac({ adapter, resources })

  await app.register(rbacFastify(rbac))

  const portal = app.rbac.portal('{{PORTAL}}', {
    // Resolved lazily at guard time, memoized per request per portal.
    // Return null when the request is unauthenticated → 401.
    getSubject: async request => {
      // TODO: resolve your authenticated user (session, JWT, ...):
      // return { id: request.user.id, context_id: request.user.tenantId }
      return null
    },
  })

  // Route usage:
  //
  // app.get(
  //   '/posts/:id',
  //   { preHandler: portal.requirePolicy('posts.read') },
  //   async request => { /* ... */ },
  // )
  //
  // Scoped policies need a resource resolver so row-level scopes can run:
  //
  // app.patch(
  //   '/posts/:id',
  //   {
  //     preHandler: portal.requirePolicy('posts.update', {
  //       resource: request => ({ type: 'post', id: (request.params as { id: string }).id }),
  //     }),
  //   },
  //   async request => { /* ... */ },
  // )

  return { rbac, portal }
}
