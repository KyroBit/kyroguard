/**
 * Framework integration contract. Registering a domain must never install an
 * app-wide hook — otherwise two domains on one app overwrite each other's subject.
 */

import type { GuardError } from '../core/errors.js'
import type { ResourceDefinition } from '../core/policy.js'
import type { Awaitable, DomainPolicyName, FilterResult, SubjectInput } from '../core/types.js'

export interface DomainOptions<TReq> {
  /** Called lazily at guard time, memoized per (request, domain); null → 401. */
  getSubject: (req: TReq) => Awaitable<SubjectInput | null>
  /**
   * This domain's resource definitions. Registered on the guard at domain
   * creation — the domain owns its policies; the guard never needs a
   * hand-assembled union.
   */
  resources?: ResourceDefinition[]
}

export interface DomainInstance<TReq, TGuard, P extends string = string> {
  readonly name: P

  /** Unqualified policy name; the domain qualifies it. */
  requirePolicy(policy: DomainPolicyName<P>): TGuard

  /** Resolves and sets the subject without guarding; register in an encapsulated scope, never app-wide. */
  subjectHook(): TGuard

  /**
   * List-path counterpart of requirePolicy: same subject resolution and the
   * same UnauthenticatedError, answering with the FilterResult trichotomy.
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
  formatError?: (error: GuardError, req: TReq) => { status: number; body: unknown }
}
