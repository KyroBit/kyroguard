/**
 * Storage adapter contract.
 *
 * Every storage backend (Drizzle pg/mysql/sqlite, Mongoose, in-memory test
 * adapter, future backends) implements this interface. The numbered clauses
 * S1–S23 below are the normative semantics; each clause maps 1:1 to a case in
 * the contract test suite (`@kyrobit/rbac/testing`,
 * runStorageAdapterContractSuite). An adapter is conforming exactly when it
 * passes that suite.
 *
 * ── Contract clauses ─────────────────────────────────────────────────────────
 * S1  Sentinels: `domain`/`tenantId` are non-null strings; ''
 *     means "none". Adapters store '' (NOT NULL DEFAULT ''), never NULL.
 * S2  Strict matching: getSubjectPolicies matches domain and tenantId by
 *     plain equality. A grant at ('', '') is returned ONLY for a request at
 *     ('', ''); a grant at ('branch','b1') ONLY for ('branch','b1'). No
 *     fallback in either direction — this is the tenant-isolation invariant.
 * S3  getSubjectPolicies returns group grants AND direct grants, both
 *     strict-matched per S2. Direct assignments are domain/tenant-scoped
 *     exactly like group assignments.
 * S4  getSubjectPolicies returns every matching grant row (no deduplication);
 *     scope precedence (null wins) is the engine's job. Ordering is
 *     normative for determinism: group grants first, then direct grants,
 *     each sorted by policy name.
 * S5  upsertPolicies inserts new policies and UPDATES label, scopeOptions and
 *     dependsOn on existing ones (a re-synced policy's metadata MUST change).
 * S6  deletePolicies cascades: it removes the policies plus every group entry
 *     and direct assignment referencing them, atomically per backend's best
 *     capability (SQL adapters wrap in a transaction).
 * S7  upsertGroup is idempotent on name; it updates label/description/flags
 *     and never duplicates or destroys the group's policy entries. On
 *     update, OMITTED optional fields keep their stored value (passing
 *     nothing never resets a flag); on insert they default to
 *     isSystem=false, isActive=true.
 * S8  setGroupPolicies replaces the group's entries exactly (removes absent,
 *     adds missing, updates changed scopes) — but only for that group.
 * S9  addGroupPolicies is additive and idempotent: re-adding an existing
 *     (group, policy) pair does not duplicate and keeps the existing scope.
 * S10 assignGroup/assignPolicy are idempotent upserts against the unique
 *     constraint on (subject, target, domain, tenantId); calling twice
 *     leaves one row.
 * S11 removeGroup/removePolicy remove ONLY the row matching the exact
 *     (subject, target, domain, tenantId) tuple.
 * S12 assignPolicy takes a fully-qualified policy name and throws
 *     UnknownPolicyError if the policy does not exist (sync must run first).
 * S13 Ownership: recordOwnership upserts — recording the same entry twice
 *     leaves one row (upsert key: S22). isOwner returns true only for an
 *     exact (ownerId, type, id) match (relation restriction: S22).
 *     removeOwnership removes every entry for the resource, all relations.
 * S14 listPolicies returns id, name, scopeOptions and dependsOn for every
 *     policy; ids are opaque non-empty strings, stable across calls;
 *     scopeOptions round-trips the value last synced via upsertPolicies.
 * S15 After upsertPolicies changes dependsOn, listPolicies reflects the new
 *     dependsOn (regression: a self-referential SQL upsert that sets columns
 *     to themselves violates S5/S15 and must fail the suite).
 * S16 getGroupPolicies returns policy NAMES (qualified) with scopes, not ids.
 * S17 ensureSchema (if implemented) is idempotent and safe to call on every
 *     sync run.
 * S18 All methods reject with an Error (never silently no-op) when the
 *     backing tables/collections are missing, so `rbac sync` can tell users
 *     to run migrations.
 * S19 Policies carry their `domain` ('' sentinel) as a stored column, set at
 *     sync time. Orphan cleanup filters on domain equality — never on
 *     name-shape heuristics (regression: v0 counted dots in policy names to
 *     guess the domain, which could delete another domain's policies).
 * S20 getSubjectPolicies excludes group grants from groups whose isActive is
 *     false (emergency kill-switch for a whole role). Direct grants are
 *     unaffected.
 * S21 getAccess returns every stored entry for the resource — all owners,
 *     all relations, with `relation` populated on each entry.
 * S22 recordOwnership upserts on (resourceType, resourceId, ownerId,
 *     relation); an omitted `relation` is stored as 'owner'. isOwner matches
 *     ONLY relation-'owner' rows — a 'granted' entry never makes isOwner
 *     true.
 * S23 removeAccess removes only the entries matching (ownerId, resourceType,
 *     resourceId) and, when a relation is given, that relation; entries for
 *     other owners or other relations survive.
 */

import type { Awaitable, ResourceRef, SubjectRef } from '../core/types.js'
import type { ResourceDefinition } from '../core/policy.js'

export interface PolicyDefinitionRow {
  /** Fully qualified, e.g. 'admin.posts.read' — the engine does all prefixing. */
  name: string
  /** The domain this policy was synced under; '' sentinel (S19). */
  domain: string
  label: string
  scopeOptions: string[]
  /** Fully qualified. */
  dependsOn: string[]
}

export interface PolicyRecord {
  id: string
  name: string
  domain: string
  scopeOptions: string[]
  dependsOn: string[]
}

/** One grant row. scope: null = unrestricted, string = restricted to that scope. */
export interface PolicyGrant {
  name: string
  scope: string | null
}

export interface GroupRecord {
  id: string
  name: string
  label: string
  isSystem: boolean
  isActive: boolean
}

export interface GroupPolicyEntry {
  policyName: string
  scope: string | null
}

export interface OwnershipEntry {
  resourceType: string
  resourceId: string
  ownerId: string
  /** Access relation; omitted means 'owner' — adapters store 'owner' (S22). */
  relation?: string
  /** '' sentinel — usually the domain the resource was created from. */
  domain: string
  /** '' sentinel — the tenant the resource was created in. */
  tenantId: string
}

/**
 * Optional list-filtering capability: native query fragments for the
 * built-in scopes plus fragment composition. owned/inTenant/granted return
 * a ScopeFilterResult-compatible `{ where }` (a native fragment for the
 * adapter's backend) or `false` when the rows cannot be expressed as a
 * fragment (fail closed).
 */
export interface ListFilters {
  owned(subjectId: string, resource: ResourceDefinition, db: unknown): Awaitable<{ where: unknown } | false>
  inTenant(tenantId: string, resource: ResourceDefinition, db: unknown): Awaitable<{ where: unknown } | false>
  granted(subjectId: string, resource: ResourceDefinition, db: unknown): Awaitable<{ where: unknown } | false>
  /** OR-combine collected fragments: drizzle or(...), Prisma { OR: [...] }, Mongo { $or: [...] }. */
  or(fragments: unknown[]): unknown
  /** Canonical impossible predicate: sql`1 = 0` / { $expr: { $eq: [0, 1] } }. */
  none(): unknown
}

export interface AdapterCapabilities {
  /** trackedDb (Drizzle) / rbacMongoosePlugin (Mongoose) available. */
  autoOwnershipTracking: boolean
  /** @deprecated Superseded by listFiltering. */
  queryScoping: boolean
  /** listFilters implemented for this backend. Absent means false. */
  listFiltering?: boolean
}

export class UnknownPolicyError extends Error {
  constructor(policyName: string) {
    super(`[rbac] Policy "${policyName}" not found — run \`rbac sync\` first.`)
    this.name = 'UnknownPolicyError'
  }
}

export class UnknownScopeError extends Error {
  constructor(policyName: string, scope: string) {
    super(
      `[rbac] Scope "${scope}" is not among the scopeOptions of policy "${policyName}" — declare it on the policy and re-sync.`,
    )
    this.name = 'UnknownScopeError'
  }
}

export interface StorageAdapter {
  /** Identifies the adapter in diagnostics (`rbac status`) and CLI dispatch. */
  readonly id: string
  readonly capabilities: AdapterCapabilities

  /** Optional DDL/index hook, run by `rbac sync` before writing (S17). */
  ensureSchema?(): Promise<void>
  /** Release connections. Called by the CLI after sync. */
  close?(): Promise<void>

  upsertPolicies(rows: PolicyDefinitionRow[]): Promise<void>
  listPolicies(): Promise<PolicyRecord[]>
  /** Cascades group entries and direct assignments (S6). */
  deletePolicies(ids: string[]): Promise<void>

  upsertGroup(group: {
    name: string
    label: string
    description?: string
    isSystem?: boolean
    isActive?: boolean
  }): Promise<void>
  listGroups(): Promise<GroupRecord[]>
  getGroupPolicies(groupName: string): Promise<GroupPolicyEntry[]>
  setGroupPolicies(groupName: string, entries: GroupPolicyEntry[]): Promise<void>
  addGroupPolicies(groupName: string, entries: GroupPolicyEntry[]): Promise<void>

  assignGroup(ref: SubjectRef, groupName: string): Promise<void>
  removeGroup(ref: SubjectRef, groupName: string): Promise<void>
  assignPolicy(ref: SubjectRef, policyName: string, scope?: string | null): Promise<void>
  removePolicy(ref: SubjectRef, policyName: string): Promise<void>

  /** Group + direct grants, both strict-matched on (domain, tenantId) (S2, S3). */
  getSubjectPolicies(ref: SubjectRef): Promise<PolicyGrant[]>

  recordOwnership(entries: OwnershipEntry[]): Promise<void>
  isOwner(ownerId: string, resource: ResourceRef): Promise<boolean>
  removeOwnership(resource: ResourceRef): Promise<void>
  /** Every entry for the resource, all relations (S21). Conforming adapters implement this; consumers fail closed when absent. */
  getAccess?(resource: ResourceRef): Promise<OwnershipEntry[]>
  /** Remove the matching entries only (S23). Conforming adapters implement this; consumers fail closed when absent. */
  removeAccess?(ownerId: string, resource: ResourceRef, relation?: string): Promise<void>

  /** List-filtering capability — absent when the backend cannot compile scope fragments. */
  listFilters?: ListFilters
}
