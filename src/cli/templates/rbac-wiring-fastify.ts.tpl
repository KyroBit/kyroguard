/**
 * RBAC wiring for Fastify. Finish the TODOs, then call registerRbac from your
 * server bootstrap. Guards throw typed RbacErrors through Fastify's own error
 * pipeline: 401 unauthenticated, 403 policy/scope denied, 404 resource not
 * found — your error handler and onSend hooks keep working.
 */
import { createRbac } from '@kyrobit/kyroguard'
import { rbacFastify } from '@kyrobit/kyroguard/fastify'
import { resources } from './policies.js'
import type { StorageAdapter } from '@kyrobit/kyroguard'
import type { FastifyInstance } from 'fastify'

export async function registerRbac(app: FastifyInstance, adapter: StorageAdapter) {
  // Reuse your app's adapter/db handle — same construction as kyroguard.config.ts.
  const rbac = createRbac({ adapter, resources })

  await app.register(rbacFastify(rbac))

  const domain = app.rbac.domain('{{DOMAIN}}', {
    // Resolved lazily at guard time, memoized per request per domain.
    // Return null when the request is unauthenticated → 401.
    getSubject: async request => {
      // TODO: resolve your authenticated user (session, JWT, ...):
      // return { id: request.user.id, tenant_id: request.user.tenantId }
      return null
    },
  })

  // Route usage:
  //
  // app.get(
  //   '/posts/:id',
  //   { preHandler: domain.requirePolicy('posts.read') },
  //   async request => { /* ... */ },
  // )
  //
  // Scoped policies need a resource resolver so row-level scopes can run:
  //
  // app.patch(
  //   '/posts/:id',
  //   {
  //     preHandler: domain.requirePolicy('posts.update', {
  //       resource: request => ({ type: 'post', id: (request.params as { id: string }).id }),
  //     }),
  //   },
  //   async request => { /* ... */ },
  // )

  return { rbac, domain }
}
