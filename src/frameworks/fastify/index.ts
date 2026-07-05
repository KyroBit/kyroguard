import fp from 'fastify-plugin'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { MisconfiguredError, RbacError } from '../../core/errors.js'
import { qualifyPolicyName } from '../../core/types.js'
import type { Subject } from '../../core/types.js'
import type { Rbac } from '../../index.js'
import type { ErrorFormatter, PortalInstance, PortalOptions } from '../contract.js'

/** Async guard compatible with Fastify's preHandler/onRequest hook slots. */
export type FastifyRbacGuard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>

export type FastifyPortal<P extends string = string> = PortalInstance<
  FastifyRequest,
  FastifyRbacGuard,
  P
>

export interface FastifyRbacDecoration {
  portal<P extends string>(name: P, options: PortalOptions<FastifyRequest>): FastifyPortal<P>
  setSubject(subject: Subject): void
  addExtra(extra: Record<string, unknown>): void
  readonly cache: Rbac['cache']
}

declare module 'fastify' {
  interface FastifyInstance {
    rbac: FastifyRbacDecoration
  }
}

export type RbacFastifyOptions = ErrorFormatter<FastifyRequest>

export function rbacFastify(rbac: Rbac, options?: RbacFastifyOptions): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async app => {
    // Callback-style on purpose: under Bun, ALS context does not propagate out
    // of `await new Promise(resolve => store.run(..., resolve))`. Entering the
    // store inside the hook's done() call stack is the only portable pattern.
    app.addHook('onRequest', (_req, _reply, done) => {
      rbac.engine.store.enter(() => done())
    })

    const decoration: FastifyRbacDecoration = {
      portal: <P extends string>(name: P, portalOptions: PortalOptions<FastifyRequest>) =>
        createPortal(rbac, options, name, portalOptions),
      setSubject: subject => rbac.engine.store.setSubject(subject),
      addExtra: extra => rbac.engine.store.addExtra(extra),
      cache: rbac.cache,
    }
    app.decorate('rbac', decoration)
  }

  return fp(plugin, { name: '@kyrobit/rbac', fastify: '5.x' })
}

function createPortal<P extends string>(
  rbac: Rbac,
  pluginOptions: RbacFastifyOptions | undefined,
  name: P,
  options: PortalOptions<FastifyRequest>,
): FastifyPortal<P> {
  const store = rbac.engine.store

  // Memoized per (request, portal) — null results included, so a failed
  // resolution is not retried and two portals on one app never collide.
  const resolveSubject = async (req: FastifyRequest): Promise<Subject | null> => {
    const requestStore = store.get()
    if (!requestStore) {
      throw new MisconfiguredError(
        'rbac request context is missing — register rbacFastify() on this Fastify instance before handling requests',
      )
    }
    if (requestStore.portalSubjects.has(name)) {
      const memoized = requestStore.portalSubjects.get(name) ?? null
      if (memoized) store.setSubject(memoized)
      return memoized
    }
    const input = await options.getSubject(req)
    // Omit<Subject, 'portal'> erases `id`'s declared type behind the index
    // signature; the contract guarantees the runtime shape, so re-assert it.
    const subject: Subject | null =
      input === null ? null : { ...input, id: input.id as string, portal: name }
    requestStore.portalSubjects.set(name, subject)
    if (subject) store.setSubject(subject)
    return subject
  }

  return {
    name,

    requirePolicy(policy, guardOptions) {
      const qualified = qualifyPolicyName(name, policy)
      const resolveResource = guardOptions?.resource
      return async (req, reply) => {
        try {
          const subject = await resolveSubject(req)
          await rbac.engine.authorize(subject, qualified, {
            resource: resolveResource ? () => resolveResource(req) : undefined,
          })
        } catch (error) {
          if (error instanceof RbacError && pluginOptions?.formatError) {
            const { status, body } = pluginOptions.formatError(error, req)
            reply.code(status)
            await reply.send(body)
            // Returning the reply marks the response as handled — never
            // hijack(): onSend hooks and CORS headers must keep running.
            return reply
          }
          // Default: throw through Fastify's own error pipeline. RbacError
          // carries statusCode + code, so the default serializer is correct.
          throw error
        }
        return undefined
      }
    },

    contextHook() {
      return async req => {
        await resolveSubject(req)
      }
    },

    assignGroup: (subjectId, group, opts) =>
      rbac.admin.assignGroup({ subjectId, portal: name, contextId: opts?.contextId }, group),

    removeGroup: (subjectId, group, opts) =>
      rbac.admin.removeGroup({ subjectId, portal: name, contextId: opts?.contextId }, group),

    assignPolicy: (subjectId, policy, opts) =>
      rbac.admin.assignPolicy(
        { subjectId, portal: name, contextId: opts?.contextId },
        qualifyPolicyName(name, policy),
        opts?.scope,
      ),

    removePolicy: (subjectId, policy, opts) =>
      rbac.admin.removePolicy(
        { subjectId, portal: name, contextId: opts?.contextId },
        qualifyPolicyName(name, policy),
      ),
  }
}
