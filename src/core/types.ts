export type Awaitable<T> = T | Promise<T>

/**
 * Augmented from user projects via the CLI-generated kyroguard.d.ts. Must stay
 * empty: augmentation ADDS members, TypeScript rejects re-declaring one.
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
 * What a domain's getSubject returns — the domain adds `domain` itself.
 * Not Omit<Subject, 'domain'>: the index signature makes Omit erase `id`.
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

/** Exactly one layer qualifies policy names: the engine. */
export function qualifyPolicyName(domain: string, policy: string): QualifiedPolicyName {
  return domain === '' ? policy : `${domain}.${policy}`
}

/**
 * Resolved grants for one subject: policy name → null (unrestricted) or every
 * granted scope name (deduped, OR semantics on both paths).
 */
export type PolicyMap = Map<string, string[] | null>

/**
 * The list-path decision trichotomy returned by filterFor. `none` is an
 * answer (serve an empty list), never an error — guards answer with errors,
 * lists answer with emptiness.
 */
export type FilterResult =
  | { kind: 'all' }
  | { kind: 'none'; reason: 'no-policy' | 'scope-denied' | 'unfilterable' }
  | { kind: 'where'; where: unknown }

export interface ResourceRef {
  type: string
  id: string
}

/**
 * Fired after every decision. Hook errors are swallowed — observability must
 * never affect authorization.
 */
export interface DecisionEvent {
  subjectId: string
  domain: string
  tenantId: string
  policy: QualifiedPolicyName
  decision: 'allow' | 'deny'
  reason: 'granted' | 'super' | 'no-policy' | 'scope-denied' | 'no-subject' | 'resource-not-found'
  /** Which evaluation path decided: authorize() = 'guard', filterFor() = 'list'. */
  mode: 'guard' | 'list'
  scope: string | null
  cacheHit: boolean
  durationMs: number
}

export type DecisionHook = (event: DecisionEvent) => void
