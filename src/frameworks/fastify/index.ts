import fp from 'fastify-plugin'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { MisconfiguredError, KyroguardError } from '../../core/errors.js'
import { qualifyPolicyName } from '../../core/types.js'
import type { Subject } from '../../core/types.js'
import type { ResourceDefinition } from '../../core/policy.js'
import type { Kyroguard } from '../../index.js'
import { defaultResourceResolver } from '../contract.js'
import type { ErrorFormatter, DomainInstance, DomainOptions } from '../contract.js'

/** Async guard compatible with Fastify's preHandler/onRequest hook slots. */
export type FastifyKyroguardGuard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>

export type FastifyDomain<P extends string = string> = DomainInstance<
  FastifyRequest,
  FastifyKyroguardGuard,
  P
>

export interface FastifyKyroguardDecoration {
  domain<P extends string>(name: P, options: DomainOptions<FastifyRequest>): FastifyDomain<P>
  /** Single-area apps don't need a domain name — policies stay unprefixed. */
  domain(options: DomainOptions<FastifyRequest>): FastifyDomain<''>
  setSubject(subject: Subject): void
  addExtra(extra: Record<string, unknown>): void
  readonly cache: Kyroguard['cache']
}

declare module 'fastify' {
  interface FastifyInstance {
    kyroguard: FastifyKyroguardDecoration
  }
}

export type KyroguardFastifyOptions = ErrorFormatter<FastifyRequest>

export function kyroguardFastify(guard: Kyroguard, options?: KyroguardFastifyOptions): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async app => {
    // Callback-style on purpose: under Bun, ALS context does not propagate out
    // of `await new Promise(resolve => store.run(..., resolve))`. Entering the
    // store inside the hook's done() call stack is the only portable pattern.
    app.addHook('onRequest', (_req, _reply, done) => {
      guard.engine.store.enter(() => done())
    })

    const decoration: FastifyKyroguardDecoration = {
      domain: (<P extends string>(
        nameOrOptions: P | DomainOptions<FastifyRequest>,
        domainOptions?: DomainOptions<FastifyRequest>,
      ) =>
        typeof nameOrOptions === 'string'
          ? createDomain(guard, options, nameOrOptions, domainOptions!)
          : createDomain(guard, options, '', nameOrOptions)) as FastifyKyroguardDecoration['domain'],
      setSubject: subject => guard.engine.store.setSubject(subject),
      addExtra: extra => guard.engine.store.addExtra(extra),
      cache: guard.cache,
    }
    app.decorate('kyroguard', decoration)
  }

  return fp(plugin, { name: '@kyrobit/kyroguard', fastify: '5.x' })
}

function createDomain<P extends string>(
  guard: Kyroguard,
  pluginOptions: KyroguardFastifyOptions | undefined,
  name: P,
  options: DomainOptions<FastifyRequest>,
): FastifyDomain<P> {
  const store = guard.engine.store

  // Memoized per (request, domain), null results included — two domains on
  // one app must never collide.
  const resolveSubject = async (req: FastifyRequest): Promise<Subject | null> => {
    const requestStore = store.get()
    if (!requestStore) {
      throw new MisconfiguredError(
        'kyroguard request context is missing — register kyroguardFastify() on this Fastify instance before handling requests',
      )
    }
    if (requestStore.domainSubjects.has(name)) {
      const memoized = requestStore.domainSubjects.get(name) ?? null
      if (memoized) store.setSubject(memoized)
      return memoized
    }
    const input = await options.getSubject(req)
    // Omit<Subject, 'domain'> erases `id`'s declared type behind the index
    // signature; the contract guarantees the runtime shape, so re-assert it.
    const subject: Subject | null =
      input === null ? null : { ...input, id: input.id as string, domain: name }
    requestStore.domainSubjects.set(name, subject)
    if (subject) store.setSubject(subject)
    return subject
  }

  return {
    name,

    requirePolicy(policy, guardOptions) {
      const qualified = qualifyPolicyName(name, policy)
      const resolveResource = guardOptions?.resource
      const filterTarget = guard.resourceForPolicy.get(policy)
      return async (req, reply) => {
        try {
          const subject = await resolveSubject(req)
          await guard.engine.authorize(subject, qualified, {
            resource: resolveResource
              ? () => resolveResource(req)
              : defaultResourceResolver(filterTarget, req.params),
          })
          if (filterTarget) await guard.engine.storeFilterFor(subject, qualified, filterTarget)
        } catch (error) {
          if (error instanceof KyroguardError && pluginOptions?.formatError) {
            const { status, body } = pluginOptions.formatError(error, req)
            reply.code(status)
            await reply.send(body)
            // Returning the reply marks the response as handled — never
            // hijack(): onSend hooks and CORS headers must keep running.
            return reply
          }
          throw error
        }
        return undefined
      }
    },

    subjectHook() {
      return async req => {
        await resolveSubject(req)
      }
    },

    async filterFor(req, policy) {
      const subject = await resolveSubject(req)
      return guard.engine.filterFor(subject, qualifyPolicyName(name, policy), filterResource(guard, policy))
    },

    assignGroup: (subjectId, group, opts) =>
      guard.admin.assignGroup({ subjectId, domain: name, tenantId: opts?.tenantId }, group),

    removeGroup: (subjectId, group, opts) =>
      guard.admin.removeGroup({ subjectId, domain: name, tenantId: opts?.tenantId }, group),

    assignPolicy: (subjectId, policy, opts) =>
      guard.admin.assignPolicy(
        { subjectId, domain: name, tenantId: opts?.tenantId },
        qualifyPolicyName(name, policy),
        opts?.scope,
      ),

    removePolicy: (subjectId, policy, opts) =>
      guard.admin.removePolicy(
        { subjectId, domain: name, tenantId: opts?.tenantId },
        qualifyPolicyName(name, policy),
      ),
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
