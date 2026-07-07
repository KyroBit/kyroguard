/**
 * Framework integration contract. Registering a domain must never install an
 * app-wide hook — otherwise two domains on one app overwrite each other's subject.
 */

import type { KyroguardError } from '../core/errors.js'
import type { Awaitable, DomainPolicyName, FilterResult, ResourceRef, SubjectInput } from '../core/types.js'

export interface GuardOptions<TReq> {
  /** Resolves the row-level target for scoped grants; when omitted, defaults to the policy's owning resource type + the route's `params.id` when both exist. */
  resource?: (req: TReq) => Awaitable<ResourceRef | null | undefined>
}

/**
 * Must return undefined — never a resolver that yields null — when the target
 * or id is missing: a resolver resolving null is a 404, while no resolver
 * lets the scopes decide on null (row scopes fail closed).
 */
export function defaultResourceResolver(
  target: { type: string } | undefined,
  params: unknown,
): (() => ResourceRef) | undefined {
  if (!target) return undefined
  const id =
    typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>).id
      : undefined
  if (typeof id !== 'string' || id === '') return undefined
  return () => ({ type: target.type, id })
}

export interface DomainOptions<TReq> {
  /** Called lazily at guard time, memoized per (request, domain); null → 401. */
  getSubject: (req: TReq) => Awaitable<SubjectInput | null>
}

export interface DomainInstance<TReq, TGuard, P extends string = string> {
  readonly name: P

  /** Unqualified policy name; the domain qualifies it. */
  requirePolicy(policy: DomainPolicyName<P>, options?: GuardOptions<TReq>): TGuard

  /** Resolves and sets the subject without guarding; register in an encapsulated scope, never app-wide. */
  subjectHook(): TGuard

  /**
   * List-path counterpart of requirePolicy: same subject resolution and the
   * same UnauthenticatedError, answering with the FilterResult trichotomy.
   * Optional until every integration ships it (next phase of the RFC).
   */
  filterFor?(req: TReq, policy: DomainPolicyName<P>): Promise<FilterResult>

  assignGroup(subjectId: string, group: string, options?: { tenantId?: string }): Promise<void>
  removeGroup(subjectId: string, group: string, options?: { tenantId?: string }): Promise<void>
  assignPolicy(
    subjectId: string,
    policy: DomainPolicyName<P>,
    options?: { tenantId?: string; scope?: string },
  ): Promise<void>
  removePolicy(
    subjectId: string,
    policy: DomainPolicyName<P>,
    options?: { tenantId?: string },
  ): Promise<void>
}

export interface ErrorFormatter<TReq> {
  /** Override the default { message, code } body per framework instance. */
  formatError?: (error: KyroguardError, req: TReq) => { status: number; body: unknown }
}
