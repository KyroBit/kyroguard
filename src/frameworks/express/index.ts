import { MisconfiguredError, GuardError } from '../../core/errors.js'
import { normalizeSentinel, qualifyPolicyName } from '../../core/types.js'
import type { ErrorRequestHandler, Request, RequestHandler } from 'express'
import type { Subject } from '../../core/types.js'
import type { ResourceDefinition } from '../../core/policy.js'
import type { Guard } from '../../index.js'
import { domainGrants } from '../contract.js'
import type { ErrorFormatter, DomainInstance, DomainOptions } from '../contract.js'

export type { DomainGrants } from '../contract.js'

export interface ExpressGuardOptions extends ErrorFormatter<Request> {}

export interface ExpressGuard {
  /** Opens the per-request ALS context. Register once, before any domain guard. */
  context(): RequestHandler
  /** Hook-free domain factory — registering it never touches app-wide state. */
  domain<P extends string>(
    name: P,
    options: DomainOptions<Request>,
  ): DomainInstance<Request, RequestHandler, P>
  /** Terminal error middleware: renders GuardError, delegates everything else. */
  errorHandler(): ErrorRequestHandler
}

export function kyroguardExpress(guard: Guard, options: ExpressGuardOptions = {}): ExpressGuard {
  return {
    context() {
      return (_req, _res, next) => {
        // Callback form is mandatory: under Bun, a promise-wrapped store.run()
        // does not propagate ALS context to the rest of the middleware chain.
        guard.engine.store.enter(next)
      }
    },

    domain: (<P extends string>(name: P, domainOptions: DomainOptions<Request>) =>
      buildDomain(guard, name, domainOptions)) as ExpressGuard['domain'],

    errorHandler() {
      return (error: unknown, req, res, next) => {
        if (!(error instanceof GuardError) || res.headersSent) {
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

/**
 * Create a domain — a plain value you can define in a module
 * (src/kyroguard/domains.ts), export, and import next to any route.
 * `kyroguardExpress(guard).context()` must still be registered before any
 * guarded route; it opens the per-request context the guards run in.
 */
export function createDomain<P extends string>(
  guard: Guard,
  name: P,
  options: DomainOptions<Request>,
): DomainInstance<Request, RequestHandler, P> {
  return buildDomain(guard, name, options)
}

function buildDomain<P extends string>(
  guard: Guard,
  name: P,
  options: DomainOptions<Request>,
): DomainInstance<Request, RequestHandler, P> {
  guard.registerResources(name, options.resources)
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

  // The domain supplies its own name, so a grant can never be filed under one
  // domain while naming another's policy.
  const ref = (subjectId: string, tenantId?: string) => ({
    subjectId,
    domain: name,
    tenantId: normalizeSentinel(tenantId),
  })

  return {
    name,

    requirePolicy(policy: string): RequestHandler {
      const qualified = qualifyPolicyName(name, policy)
      const filterTarget =
        guard.resourceForPolicy.get(qualified) ?? guard.resourceForPolicy.get(policy)
      return asyncGuard(async req => {
        const subject = await resolveSubject(req)
        await guard.engine.authorize(subject, qualified)
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
      return guard.engine.filterFor(subject, qualifyPolicyName(name, policy), filterResource(guard, name, policy))
    },

    can: async (req: Request, policy: string) => {
      const subject = await resolveSubject(req)
      return guard.engine.can(subject, qualifyPolicyName(name, policy))
    },

    grantsFor: async (req: Request) => {
      const subject = await resolveSubject(req)
      return domainGrants(guard, name, options.resources, subject)
    },

    groupsOf: (subjectId: string, opts?: { tenantId?: string }) =>
      guard.engine.groupsOf(ref(subjectId, opts?.tenantId)),
    assignGroup: (subjectId: string, group: string, opts?: { tenantId?: string }) =>
      guard.engine.assignGroup(ref(subjectId, opts?.tenantId), group),
    removeGroup: (subjectId: string, group: string, opts?: { tenantId?: string }) =>
      guard.engine.removeGroup(ref(subjectId, opts?.tenantId), group),
    assignPolicy: (
      subjectId: string,
      policy: string,
      opts?: { tenantId?: string; scope?: string },
    ) =>
      guard.engine.assignPolicy(
        ref(subjectId, opts?.tenantId),
        qualifyPolicyName(name, policy),
        opts?.scope,
      ),
    removePolicy: (subjectId: string, policy: string, opts?: { tenantId?: string }) =>
      guard.engine.removePolicy(ref(subjectId, opts?.tenantId), qualifyPolicyName(name, policy)),
  }
}

function filterResource(guard: Guard, domain: string, policy: string): ResourceDefinition {
  const resource =
    guard.resourceForPolicy.get(qualifyPolicyName(domain, policy)) ??
    guard.resourceForPolicy.get(policy)
  if (!resource) {
    throw new MisconfiguredError(
      `[kyroguard] filterFor: no registered resource defines policy "${policy}" — add it to createGuard({ resources }).`,
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
