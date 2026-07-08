/**
 * Your kyroguard domains, as plain importable values. Finish the TODOs, then
 * register the plugin ONCE in your server bootstrap:
 *
 *   import { kyroguardFastify } from '@kyrobit/kyroguard/fastify'
 *   import { guard } from './kyroguard/domains.js'
 *
 *   await app.register(kyroguardFastify(guard))
 *
 * Guards throw typed GuardErrors through Fastify's own error pipeline:
 * 401 unauthenticated, 403 policy/scope denied, 404 resource not found —
 * your error handler and onSend hooks keep working.
 */
import { createGuard } from '@kyrobit/kyroguard'
import { createDomain } from '@kyrobit/kyroguard/fastify'
{{ADAPTER_IMPORTS}}
import { resources } from './policies/{{DOMAIN}}.js'

{{ADAPTER_CREATE}}

export const guard = createGuard({ adapter, resources })

export const {{DOMAIN_EXPORT}} = createDomain(guard, '{{DOMAIN}}', {
  // Resolved lazily at guard time, memoized per request per domain.
  // Return null when the request is unauthenticated → 401.
  getSubject: async request => {
    // TODO: resolve your authenticated user (session, JWT, ...):
    // return { id: request.user.id, tenant_id: request.user.tenantId }
    return null
  },
})

// Route usage — import the domain next to any route:
//
// import { {{DOMAIN_EXPORT}} } from '../kyroguard/domains.js'
//
// app.get(
//   '/posts/:id',
//   { preHandler: {{DOMAIN_EXPORT}}.requirePolicy('posts.read') },
//   async request => { /* ... */ },
// )
//
// Scoped policies need a resource resolver so row-level scopes can run:
//
// app.patch(
//   '/posts/:id',
//   {
//     preHandler: {{DOMAIN_EXPORT}}.requirePolicy('posts.update', {
//       resource: request => ({ type: 'post', id: (request.params as { id: string }).id }),
//     }),
//   },
//   async request => { /* ... */ },
// )
