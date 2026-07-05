/**
 * Framework integration contract. Registering a domain must never install an
 * app-wide hook — otherwise two domains on one app overwrite each other's subject.
 */

import type { RbacError } from '../core/errors.js'
import type { Awaitable, DomainPolicyName, FilterResult, ResourceRef, SubjectInput } from '../core/types.js'

export interface GuardOptions<TReq> {
  /** Resolves the row-level target; required when the resolved grant is scoped. */
  resource?: (req: TReq) => Awaitable<ResourceRef | null | undefined>
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
  formatError?: (error: RbacError, req: TReq) => { status: number; body: unknown }
}
