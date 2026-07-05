/**
 * Express 4/5 integration.
 *
 * Guards never write responses: failures travel through next(err) into the
 * app's error pipeline, terminated by errorHandler(). Async rejections are
 * forwarded explicitly so behavior is identical on Express 4 (no automatic
 * async error forwarding) and Express 5.
 */

import { MisconfiguredError, RbacError } from '../../core/errors.js'
import { qualifyPolicyName } from '../../core/types.js'
import type { ErrorRequestHandler, Request, RequestHandler } from 'express'
import type { Subject } from '../../core/types.js'
import type { Rbac } from '../../index.js'
import type { ErrorFormatter, GuardOptions, PortalInstance, PortalOptions } from '../contract.js'

export interface ExpressRbacOptions extends ErrorFormatter<Request> {}

export interface ExpressRbac {
  /** Opens the per-request ALS context. Register once, before any portal guard. */
  context(): RequestHandler
  /** Hook-free portal factory — registering it never touches app-wide state. */
  portal<P extends string>(
    name: P,
    options: PortalOptions<Request>,
  ): PortalInstance<Request, RequestHandler, P>
  /** Terminal error middleware: renders RbacError, delegates everything else. */
  errorHandler(): ErrorRequestHandler
}

export function rbacExpress(rbac: Rbac, options: ExpressRbacOptions = {}): ExpressRbac {
  return {
    context() {
      return (_req, _res, next) => {
        // Callback form is mandatory: under Bun, a promise-wrapped store.run()
        // does not propagate ALS context to the rest of the middleware chain.
        rbac.engine.store.enter(next)
      }
    },

    portal(name, portalOptions) {
      return createPortal(rbac, name, portalOptions)
    },

    errorHandler() {
      return (error: unknown, req, res, next) => {
        if (!(error instanceof RbacError) || res.headersSent) {
          next(error)
          return
        }
        if (options.formatError) {
          const { status, body } = options.formatError(error, req)
          res.status(status).json(body)
          return
        }
        res.status(error.statusCode).json(error.toBody())
      }
    },
  }
}

function createPortal<P extends string>(
  rbac: Rbac,
  name: P,
  options: PortalOptions<Request>,
): PortalInstance<Request, RequestHandler, P> {
  const resolveSubject = async (req: Request): Promise<Subject | null> => {
    const store = rbac.engine.store.get()
    if (!store) {
      throw new MisconfiguredError(
        `[rbac] No request context for portal "${name}" — register rbacExpress(rbac).context() before its guards.`,
      )
    }
    if (store.portalSubjects.has(name)) {
      const memoized = store.portalSubjects.get(name) ?? null
      if (memoized) store.subject = memoized
      return memoized
    }
    const input = await options.getSubject(req)
    // Cast: Omit<Subject, 'portal'> collapses to its index signature (Subject
    // has [key: string]: unknown), erasing `id: string` from the spread type.
    // The engine still rejects a missing id at runtime (401).
    const subject: Subject | null = input ? { ...(input as Subject), portal: name } : null
    store.portalSubjects.set(name, subject)
    if (subject) store.subject = subject
    return subject
  }

  const adminRef = (subjectId: string, contextId?: string) => ({
    subjectId,
    portal: name,
    contextId,
  })

  return {
    name,

    requirePolicy(policy: string, guardOptions?: GuardOptions<Request>): RequestHandler {
      const qualified = qualifyPolicyName(name, policy)
      const resource = guardOptions?.resource
      return guard(async req => {
        const subject = await resolveSubject(req)
        await rbac.engine.authorize(
          subject,
          qualified,
          resource ? { resource: () => resource(req) } : undefined,
        )
      })
    },

    contextHook(): RequestHandler {
      return guard(async req => {
        await resolveSubject(req)
      })
    },

    assignGroup: (subjectId: string, group: string, opts?: { contextId?: string }) =>
      rbac.admin.assignGroup(adminRef(subjectId, opts?.contextId), group),
    removeGroup: (subjectId: string, group: string, opts?: { contextId?: string }) =>
      rbac.admin.removeGroup(adminRef(subjectId, opts?.contextId), group),
    assignPolicy: (
      subjectId: string,
      policy: string,
      opts?: { contextId?: string; scope?: string | null },
    ) =>
      rbac.admin.assignPolicy(
        adminRef(subjectId, opts?.contextId),
        qualifyPolicyName(name, policy),
        opts?.scope,
      ),
    removePolicy: (subjectId: string, policy: string, opts?: { contextId?: string }) =>
      rbac.admin.removePolicy(adminRef(subjectId, opts?.contextId), qualifyPolicyName(name, policy)),
  }
}

/**
 * Express-4-safe async wrapper. next() is called only on fulfillment, outside
 * any catch path, so a throw from downstream middleware can never re-enter
 * next(err) here. A falsy rejection is upgraded to an error — it must never
 * fall through as a successful next() (that would authorize the request).
 */
function guard(run: (req: Request) => Promise<void>): RequestHandler {
  return (req, _res, next) => {
    run(req).then(
      () => next(),
      (error: unknown) =>
        next(error ?? new MisconfiguredError('[rbac] Guard rejected without an error value')),
    )
  }
}
