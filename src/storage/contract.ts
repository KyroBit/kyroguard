/**
 * Storage adapter contract.
 *
 * Every storage backend (Drizzle pg/mysql/sqlite, Mongoose, in-memory test
 * adapter, future backends) implements this interface. The numbered clauses
 * S1–S18 below are the normative semantics; each clause maps 1:1 to a case in
 * the contract test suite (`@kyrobit/rbac/testing`,
 * runStorageAdapterContractSuite). An adapter is conforming exactly when it
 * passes that suite.
 *
 * ── Contract clauses ─────────────────────────────────────────────────────────
 * S1  Sentinels: `portal`/`contextId`/`contextType` are non-null strings; ''
 *     means "none". Adapters store '' (NOT NULL DEFAULT ''), never NULL.
 * S2  Strict matching: getSubjectPolicies matches portal and contextId by
 *     plain equality. A grant at ('', '') is returned ONLY for a request at
 *     ('', ''); a grant at ('branch','b1') ONLY for ('branch','b1'). No
 *     fallback in either direction — this is the tenant-isolation invariant.
 * S3  getSubjectPolicies returns group grants AND direct grants, both
 *     strict-matched per S2. Direct assignments are portal/context-scoped
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
 *     constraint on (subject, target, portal, contextId); calling twice
 *     leaves one row.
 * S11 removeGroup/removePolicy remove ONLY the row matching the exact
 *     (subject, target, portal, contextId) tuple.
 * S12 assignPolicy takes a fully-qualified policy name and throws
 *     UnknownPolicyError if the policy does not exist (sync must run first).
 * S13 Ownership: recordOwnership upserts on (resourceType, resourceId,
 *     ownerId) — recording twice leaves one row. isOwner returns true only
 *     for an exact (ownerId, type, id) match. removeOwnership removes all
 *     owners of the resource.
 * S14 listPolicies returns id, name and dependsOn for every policy; ids are
 *     opaque non-empty strings, stable across calls.
 * S15 After upsertPolicies changes dependsOn, listPolicies reflects the new
 *     dependsOn (regression: a self-referential SQL upsert that sets columns
 *     to themselves violates S5/S15 and must fail the suite).
 * S16 getGroupPolicies returns policy NAMES (qualified) with scopes, not ids.
 * S17 ensureSchema (if implemented) is idempotent and safe to call on every
 *     sync run.
 * S18 All methods reject with an Error (never silently no-op) when the
 *     backing tables/collections are missing, so `rbac sync` can tell users
 *     to run migrations.
 * S19 Policies carry their `portal` ('' sentinel) as a stored column, set at
 *     sync time. Orphan cleanup filters on portal equality — never on
 *     name-shape heuristics (regression: v0 counted dots in policy names to
 *     guess the portal, which could delete another portal's policies).
 * S20 getSubjectPolicies excludes group grants from groups whose isActive is
 *     false (emergency kill-switch for a whole role). Direct grants are
 *     unaffected.
 */

import type { ResourceRef, SubjectRef } from '../core/types.js'

export interface PolicyDefinitionRow {
  /** Fully qualified, e.g. 'admin.posts.read' — the engine does all prefixing. */
  name: string
  /** The portal this policy was synced under; '' sentinel (S19). */
  portal: string
  label: string
  scopeOptions: string[]
  /** Fully qualified. */
  dependsOn: string[]
}

export interface PolicyRecord {
  id: string
  name: string
  portal: string
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
  /** '' sentinel — usually the portal the resource was created from. */
  contextType: string
  /** '' sentinel — the tenant context the resource was created in. */
  contextId: string
}

export interface AdapterCapabilities {
  /** trackedDb (Drizzle) / rbacMongoosePlugin (Mongoose) available. */
  autoOwnershipTracking: boolean
  /** Automatic query scoping available for this backend. */
  queryScoping: boolean
}

export class UnknownPolicyError extends Error {
  constructor(policyName: string) {
    super(`[rbac] Policy "${policyName}" not found — run \`rbac sync\` first.`)
    this.name = 'UnknownPolicyError'
  }
}

export interface StorageAdapter {
  /** Identifies the adapter in diagnostics (`rbac status`) and CLI dispatch. */
  readonly id: string
  readonly capabilities: AdapterCapabilities

  /**
   * Optional DDL/index hook, run by `rbac sync` before writing (S17).
   * Drizzle: no-op — migrations own DDL. Mongoose: syncIndexes().
   */
  ensureSchema?(): Promise<void>
  /** Release connections. Called by the CLI after sync. */
  close?(): Promise<void>

  // ── Policy sync ────────────────────────────────────────────────────────────
  upsertPolicies(rows: PolicyDefinitionRow[]): Promise<void>
  listPolicies(): Promise<PolicyRecord[]>
  /** Cascades group entries and direct assignments (S6). */
  deletePolicies(ids: string[]): Promise<void>

  // ── Groups ─────────────────────────────────────────────────────────────────
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

  // ── Assignments ────────────────────────────────────────────────────────────
  assignGroup(ref: SubjectRef, groupName: string): Promise<void>
  removeGroup(ref: SubjectRef, groupName: string): Promise<void>
  assignPolicy(ref: SubjectRef, policyName: string, scope?: string | null): Promise<void>
  removePolicy(ref: SubjectRef, policyName: string): Promise<void>

  // ── Enforcement hot path ───────────────────────────────────────────────────
  /** Group + direct grants, both strict-matched on (portal, contextId) (S2, S3). */
  getSubjectPolicies(ref: SubjectRef): Promise<PolicyGrant[]>

  // ── Ownership (portable floor — powers Scope.owned() on every backend) ─────
  recordOwnership(entries: OwnershipEntry[]): Promise<void>
  isOwner(ownerId: string, resource: ResourceRef): Promise<boolean>
  removeOwnership(resource: ResourceRef): Promise<void>
}
