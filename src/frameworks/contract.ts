/**
 * Framework integration contract.
 *
 * A framework layer is a translator with exactly three responsibilities:
 *   1. Context — open the engine's per-request ALS store once per request.
 *   2. Portals — hook-free portal factories whose guards resolve the subject
 *      lazily AT GUARD TIME, memoized per (request, portal). Registering a
 *      portal never installs an app-wide hook, so two portals on one app can
 *      never overwrite each other's subject (v0 forPortal regression).
 *   3. Errors — guards throw typed RbacError subclasses through the
 *      framework's OWN error pipeline. No hijacked replies, no raw sockets:
 *      onSend hooks, CORS headers and custom error handlers keep working.
 */

import type { RbacError } from '../core/errors.js'
import type { Awaitable, PortalPolicyName, ResourceRef, SubjectInput } from '../core/types.js'

export interface GuardOptions<TReq> {
  /** Resolves the row-level target; required when the resolved grant is scoped. */
  resource?: (req: TReq) => Awaitable<ResourceRef | null | undefined>
}

export interface PortalOptions<TReq> {
  /**
   * Called lazily at guard time, memoized per request per portal.
   * Return null when the request has no authenticated user → 401.
   */
  getSubject: (req: TReq) => Awaitable<SubjectInput | null>
}

export interface PortalInstance<TReq, TGuard, P extends string = string> {
  readonly name: P

  /** Unqualified policy name; the portal qualifies it. */
  requirePolicy(policy: PortalPolicyName<P>, options?: GuardOptions<TReq>): TGuard

  /**
   * Optional hook/middleware that resolves and sets the subject WITHOUT
   * guarding — for unguarded routes that still need ownership tracking.
   * Register it in an encapsulated scope, never app-wide.
   */
  contextHook(): TGuard

  // Assignment sugar — auto-qualified, strict (portal = this.name):
  assignGroup(subjectId: string, group: string, options?: { contextId?: string }): Promise<void>
  removeGroup(subjectId: string, group: string, options?: { contextId?: string }): Promise<void>
  assignPolicy(
    subjectId: string,
    policy: PortalPolicyName<P>,
    options?: { contextId?: string; scope?: string | null },
  ): Promise<void>
  removePolicy(
    subjectId: string,
    policy: PortalPolicyName<P>,
    options?: { contextId?: string },
  ): Promise<void>
}

export interface ErrorFormatter<TReq> {
  /** Override the default { message, code } body per framework instance. */
  formatError?: (error: RbacError, req: TReq) => { status: number; body: unknown }
}
