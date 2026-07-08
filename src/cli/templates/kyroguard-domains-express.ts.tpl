/**
 * Your kyroguard domains, as plain importable values. Finish the TODOs, then
 * wire the two middlewares in your server bootstrap:
 *
 *   import { context, errorHandler } from './kyroguard/domains.js'
 *
 *   app.use(context())        // BEFORE any guarded route
 *   // ... your routes ...
 *   app.use(errorHandler())   // AFTER your routes
 *
 * Guards forward typed GuardErrors to Express's error pipeline via
 * next(err): 401 unauthenticated, 403 policy/scope denied, 404 resource not
 * found.
 */
import { createGuard } from '@kyrobit/kyroguard'
import { createDomain, kyroguardExpress } from '@kyrobit/kyroguard/express'
{{ADAPTER_IMPORTS}}
import { resources as {{DOMAIN_EXPORT}}Resources } from './policies/{{DOMAIN}}.js'

{{ADAPTER_CREATE}}

export const guard = createGuard({ adapter })

const { context, errorHandler } = kyroguardExpress(guard)
/** context() opens the per-request state — register BEFORE any guarded route.
 *  errorHandler() turns guard errors into JSON — register AFTER your routes. */
export { context, errorHandler }

export const {{DOMAIN_EXPORT}} = createDomain(guard, '{{DOMAIN}}', {
  // The domain owns its policies; the guard aggregates them.
  resources: {{DOMAIN_EXPORT}}Resources,
  // Resolved lazily at guard time, memoized per request per domain.
  // Return null when the request is unauthenticated → 401.
  getSubject: async req => {
    // TODO: resolve your authenticated user (session, JWT, ...):
    // return { id: req.user.id, tenant_id: req.user.tenantId }
    return null
  },
})

// Route usage — import the domain next to any route:
//
// import { {{DOMAIN_EXPORT}} } from '../kyroguard/domains.js'
//
// app.get('/posts/:id', {{DOMAIN_EXPORT}}.requirePolicy('posts.read'), handler)
//
// Scoped policies need a resource resolver so row-level scopes can run:
//
// app.patch(
//   '/posts/:id',
//   {{DOMAIN_EXPORT}}.requirePolicy('posts.update', {
//     resource: req => ({ type: 'post', id: req.params.id }),
//   }),
//   handler,
// )
