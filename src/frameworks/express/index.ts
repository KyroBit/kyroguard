import { MisconfiguredError, KyroguardError } from '../../core/errors.js'
import { qualifyPolicyName } from '../../core/types.js'
import type { ErrorRequestHandler, Request, RequestHandler } from 'express'
import type { Subject } from '../../core/types.js'
import type { ResourceDefinition } from '../../core/policy.js'
import type { Kyroguard } from '../../index.js'
import { defaultResourceResolver } from '../contract.js'
import type { ErrorFormatter, GuardOptions, DomainInstance, DomainOptions } from '../contract.js'

export interface ExpressKyroguardOptions extends ErrorFormatter<Request> {}

export interface ExpressKyroguard {
  /** Opens the per-request ALS context. Register once, before any domain guard. */
  context(): RequestHandler
  /** Hook-free domain factory — registering it never touches app-wide state. */
  domain<P extends string>(
    name: P,
    options: DomainOptions<Request>,
  ): DomainInstance<Request, RequestHandler, P>
  /** Single-area apps don't need a domain name — policies stay unprefixed. */
  domain(options: DomainOptions<Request>): DomainInstance<Request, RequestHandler, ''>
  /** Terminal error middleware: renders KyroguardError, delegates everything else. */
  errorHandler(): ErrorRequestHandler
}

export function kyroguardExpress(guard: Kyroguard, options: ExpressKyroguardOptions = {}): ExpressKyroguard {
  return {
    context() {
      return (_req, _res, next) => {
        // Callback form is mandatory: under Bun, a promise-wrapped store.run()
        // does not propagate ALS context to the rest of the middleware chain.
        guard.engine.store.enter(next)
      }
    },

    domain: (<P extends string>(
      nameOrOptions: P | DomainOptions<Request>,
      domainOptions?: DomainOptions<Request>,
    ) =>
      typeof nameOrOptions === 'string'
        ? createDomain(guard, nameOrOptions, domainOptions!)
        : createDomain(guard, '', nameOrOptions)) as ExpressKyroguard['domain'],

    errorHandler() {
      return (error: unknown, req, res, next) => {
        if (!(error instanceof KyroguardError) || res.headersSent) {
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

function createDomain<P extends string>(
  guard: Kyroguard,
  name: P,
  options: DomainOptions<Request>,
): DomainInstance<Request, RequestHandler, P> {
  const resolveSubject = async (req: Request): Promise<Subject | null> => {
    const store = guard.engine.store.get()
    if (!store) {
      throw new MisconfiguredError(
        `[kyroguard] No request context for domain "${name}" — register kyroguardExpress(guard).context() before its guards.`,
      )
    }
    if (store.domainSubjects.has(name)) {
      const memoized = store.domainSubjects.get(name) ?? null
      if (memoized) store.subject = memoized
      return memoized
    }
    const input = await options.getSubject(req)
    // Cast: Omit<Subject, 'domain'> collapses to its index signature (Subject
    // has [key: string]: unknown), erasing `id: string` from the spread type.
    // The engine still rejects a missing id at runtime (401).
    const subject: Subject | null = input ? { ...(input as Subject), domain: name } : null
    store.domainSubjects.set(name, subject)
    if (subject) store.subject = subject
    return subject
  }

  const adminRef = (subjectId: string, tenantId?: string) => ({
    subjectId,
    domain: name,
    tenantId,
  })

  return {
    name,

    requirePolicy(policy: string, guardOptions?: GuardOptions<Request>): RequestHandler {
      const qualified = qualifyPolicyName(name, policy)
      const resource = guardOptions?.resource
      const filterTarget = guard.resourceForPolicy.get(policy)
      return asyncGuard(async req => {
        const subject = await resolveSubject(req)
        await guard.engine.authorize(subject, qualified, {
          resource: resource
            ? () => resource(req)
            : defaultResourceResolver(filterTarget, req.params),
        })
        if (filterTarget) await guard.engine.storeFilterFor(subject, qualified, filterTarget)
      })
    },

    subjectHook(): RequestHandler {
      return asyncGuard(async req => {
        await resolveSubject(req)
      })
    },

    filterFor: async (req: Request, policy: string) => {
      const subject = await resolveSubject(req)
      return guard.engine.filterFor(subject, qualifyPolicyName(name, policy), filterResource(guard, policy))
    },

    assignGroup: (subjectId: string, group: string, opts?: { tenantId?: string }) =>
      guard.admin.assignGroup(adminRef(subjectId, opts?.tenantId), group),
    removeGroup: (subjectId: string, group: string, opts?: { tenantId?: string }) =>
      guard.admin.removeGroup(adminRef(subjectId, opts?.tenantId), group),
    assignPolicy: (
      subjectId: string,
      policy: string,
      opts?: { tenantId?: string; scope?: string },
    ) =>
      guard.admin.assignPolicy(
        adminRef(subjectId, opts?.tenantId),
        qualifyPolicyName(name, policy),
        opts?.scope,
      ),
    removePolicy: (subjectId: string, policy: string, opts?: { tenantId?: string }) =>
      guard.admin.removePolicy(adminRef(subjectId, opts?.tenantId), qualifyPolicyName(name, policy)),
  }
}

function filterResource(guard: Kyroguard, policy: string): ResourceDefinition {
  const resource = guard.resourceForPolicy.get(policy)
  if (!resource) {
    throw new MisconfiguredError(
      `[kyroguard] filterFor: no registered resource defines policy "${policy}" — add it to createKyroguard({ resources }).`,
    )
  }
  return resource
}

/**
 * Express-4-safe async wrapper. next() is called only on fulfillment, outside
 * any catch path, so a throw from downstream middleware can never re-enter
 * next(err) here. A falsy rejection is upgraded to an error — it must never
 * fall through as a successful next() (that would authorize the request).
 */
function asyncGuard(run: (req: Request) => Promise<void>): RequestHandler {
  return (req, _res, next) => {
    run(req).then(
      () => next(),
      (error: unknown) =>
        next(error ?? new MisconfiguredError('[kyroguard] Guard rejected without an error value')),
    )
  }
}
