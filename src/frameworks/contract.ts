/**
 * Framework integration contract. Registering a domain must never install an
 * app-wide hook — otherwise two domains on one app overwrite each other's subject.
 */

import { qualifyPolicyName } from '../core/types.js'
import type { GuardError } from '../core/errors.js'
import type { ResourceDefinition } from '../core/policy.js'
import type { GroupRecord } from '../storage/contract.js'
import type { Guard } from '../index.js'
import type {
  Awaitable,
  DomainPolicyName,
  FilterResult,
  Subject,
  SubjectInput,
} from '../core/types.js'

/** A plain object, not a PolicyMap: this one is serialized to a client. */
export type DomainGrants = Record<string, string[] | null>

/**
 * Shared so it cannot diverge: a superuser rendering different buttons on
 * Fastify and Express is the same bug twice.
 */
export async function domainGrants(
  guard: Guard,
  domain: string,
  resources: ResourceDefinition[],
  subject: Subject | null,
): Promise<DomainGrants> {
  const universe = resources.flatMap(resource =>
    resource.policies.map(policy => qualifyPolicyName(domain, policy.name)),
  )
  const map = await guard.engine.policiesOf(subject, universe)

  const prefix = `${domain}.`
  const grants: DomainGrants = {}
  for (const [policy, scopes] of map) {
    if (domain === '') grants[policy] = scopes
    else if (policy.startsWith(prefix)) grants[policy.slice(prefix.length)] = scopes
  }
  return grants
}

export interface DomainOptions<TReq> {
  /** Called lazily at guard time, memoized per (request, domain); null → 401. */
  getSubject: (req: TReq) => Awaitable<SubjectInput | null>
  /**
   * This domain's resource definitions. Registered on the guard at domain
   * creation — the domain owns its policies; the guard never needs a
   * hand-assembled union.
   */
  resources: ResourceDefinition[]
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

  /**
   * Non-throwing counterpart of requirePolicy: same subject resolution,
   * answering false where a guard would 401 or 403.
   */
  can?(req: TReq, policy: DomainPolicyName<P>): Promise<boolean>


  /** Every policy the subject holds in this domain, by its short name. A superuser holds them all. */
  policiesOf(
    subjectId: string,
    options?: { tenantId?: string; isSuper?: boolean },
  ): Promise<DomainGrants>
  /** The groups the subject belongs to in this domain, inactive ones included. */
  groupsOf(subjectId: string, options?: { tenantId?: string }): Promise<GroupRecord[]>
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
