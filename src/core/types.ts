/**
 * Core public types. This module imports nothing framework- or ORM-specific.
 */

export type Awaitable<T> = T | Promise<T>

/**
 * Augment this interface from your project (the CLI's `rbac sync` /
 * `rbac generate` writes rbac.d.ts doing exactly this) to get typed domain
 * names and per-domain policy autocompletion:
 *
 * ```ts
 * declare module '@kyrobit/rbac' {
 *   interface RbacTypes {
 *     Domain: 'admin' | 'branch'
 *     PolicyName: 'posts.read' | 'posts.write'
 *     DomainPolicies: { admin: 'posts.read' | 'posts.write'; branch: 'posts.read' }
 *   }
 * }
 * ```
 *
 * The interface is empty by default so augmentation ADDS members instead of
 * re-declaring them (TypeScript rejects re-declaring a property with a
 * narrower type). Use the Resolved* aliases below to consume it.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RbacTypes {}

/** The augmented Domain union, or string before augmentation. */
export type DomainName = RbacTypes extends { Domain: infer P extends string } ? P : string

/** The augmented PolicyName union, or string before augmentation. */
export type AnyPolicyName = RbacTypes extends { PolicyName: infer P extends string } ? P : string

/** The policy union for one domain, or string before augmentation. */
export type DomainPolicyName<P extends string> = RbacTypes extends { DomainPolicies: infer M }
  ? P extends keyof M
    ? M[P] & string
    : string
  : string

/** The authenticated principal, as resolved by the application. */
export interface Subject {
  id: string
  domain?: string
  tenant_id?: string
  /** Bypasses all policy checks. Reserve for break-glass accounts. */
  is_super?: boolean
  [key: string]: unknown
}

/**
 * What a domain's getSubject returns — domain is added by the domain itself.
 * Declared explicitly (not Omit<Subject, 'domain'>): Subject's index
 * signature makes Omit collapse to a bare index signature and erases `id`.
 */
export interface SubjectInput {
  id: string
  tenant_id?: string
  is_super?: boolean
  [key: string]: unknown
}

/**
 * Strict, normalized subject coordinates used for storage lookups and cache
 * keys. `domain` and `tenantId` use the empty-string sentinel `''` meaning
 * "none": columns are NOT NULL DEFAULT '', so strict matching is plain
 * equality on every backend and unique constraints behave identically on
 * PostgreSQL, MySQL, SQLite and MongoDB. A null-coordinate fallback is
 * structurally impossible.
 */
export interface SubjectRef {
  subjectId: string
  domain: string
  tenantId: string
}

export function toSubjectRef(subject: Subject): SubjectRef {
  return {
    subjectId: subject.id,
    domain: normalizeSentinel(subject.domain),
    tenantId: normalizeSentinel(subject.tenant_id as string | undefined),
  }
}

export function normalizeSentinel(value: string | null | undefined): string {
  return value ?? ''
}

/** A fully-qualified policy name, e.g. `admin.posts.read` for domain `admin`. */
export type QualifiedPolicyName = string

/**
 * Exactly one layer qualifies policy names: the engine. Domain guards and
 * domain assignment sugar take unqualified names and qualify them here;
 * the low-level admin API takes already-qualified names and says so.
 */
export function qualifyPolicyName(domain: string, policy: string): QualifiedPolicyName {
  return domain === '' ? policy : `${domain}.${policy}`
}

/** Resolved grants for one subject: policy name → scope (null = unrestricted). */
export type PolicyMap = Map<string, string | null>

export interface ResourceRef {
  type: string
  id: string
}

/**
 * Fired after every authorization decision (allow or deny). Errors thrown by
 * the hook are swallowed — observability must never affect authorization.
 */
export interface DecisionEvent {
  subjectId: string
  domain: string
  tenantId: string
  policy: QualifiedPolicyName
  decision: 'allow' | 'deny'
  reason: 'granted' | 'super' | 'no-policy' | 'scope-denied' | 'no-subject' | 'resource-not-found'
  scope: string | null
  cacheHit: boolean
  durationMs: number
}

export type DecisionHook = (event: DecisionEvent) => void
