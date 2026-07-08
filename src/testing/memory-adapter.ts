/**
 * In-memory reference implementation of the storage contract (S1–S23);
 * every behavior here is normative via runStorageAdapterContractSuite.
 *
 * listFilters fragments are plain predicates — `{ where: (row: { id: string })
 * => boolean }` — so engine.filterFor is fully testable without a database:
 * apply the returned predicate to your seeded rows. `or` folds predicates,
 * `none` is the always-false predicate.
 */

import { UnknownPolicyError } from '../index.js'
import type { SubjectRef } from '../index.js'
import type {
  GroupPolicyEntry,
  OwnershipEntry,
  PolicyGrant,
  StorageAdapter,
} from '../storage/contract.js'

/** The memory adapter's native list-filter fragment: a row predicate. */
export type MemoryWhere = (row: { id: string }) => boolean

interface StoredPolicy {
  id: string
  name: string
  domain: string
  label: string
  scopeOptions: string[]
  dependsOn: string[]
}

interface StoredGroup {
  id: string
  name: string
  label: string
  description: string
  isSystem: boolean
  isActive: boolean
}

interface AssignmentTuple {
  subjectId: string
  domain: string
  tenantId: string
}

interface GroupAssignment extends AssignmentTuple {
  groupName: string
}

interface DirectAssignment extends AssignmentTuple {
  policyName: string
  scope: string | null
}

interface StoredOwnership extends OwnershipEntry {
  relation: string
}

export function memoryAdapter(): StorageAdapter {
  let counter = 0
  const nextId = (): string => `mem_${++counter}`

  const policies = new Map<string, StoredPolicy>()
  const groups = new Map<string, StoredGroup>()
  const groupPolicies = new Map<string, GroupPolicyEntry[]>()
  const groupAssignments: GroupAssignment[] = []
  const directAssignments: DirectAssignment[] = []
  const ownership: StoredOwnership[] = []

  const accessMatches = (
    resourceType: string,
    resourceId: string,
    match: (row: StoredOwnership) => boolean,
  ): boolean =>
    ownership.some(
      row => row.resourceType === resourceType && row.resourceId === resourceId && match(row),
    )

  // S2: plain equality on every component — no fallback in either direction.
  const sameTuple = (assignment: AssignmentTuple, ref: SubjectRef): boolean =>
    assignment.subjectId === ref.subjectId &&
    assignment.domain === ref.domain &&
    assignment.tenantId === ref.tenantId

  const requireGroup = (name: string): StoredGroup => {
    const group = groups.get(name)
    if (!group) throw new Error(`[kyroguard] Group "${name}" not found.`)
    return group
  }

  const byName = (a: PolicyGrant, b: PolicyGrant): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0

  return {
    id: 'memory',
    capabilities: { autoOwnershipTracking: false, listFiltering: true },

    // S17: nothing to create in memory; safe on every sync run.
    async ensureSchema() {},

    // ── Policy sync ──────────────────────────────────────────────────────────

    async upsertPolicies(rows) {
      for (const row of rows) {
        const existing = policies.get(row.name)
        if (existing) {
          // S5/S15: metadata of an existing policy MUST change on re-sync.
          existing.domain = row.domain
          existing.label = row.label
          existing.scopeOptions = [...row.scopeOptions]
          existing.dependsOn = [...row.dependsOn]
        } else {
          policies.set(row.name, {
            id: nextId(),
            name: row.name,
            domain: row.domain,
            label: row.label,
            scopeOptions: [...row.scopeOptions],
            dependsOn: [...row.dependsOn],
          })
        }
      }
    },

    async listPolicies() {
      return [...policies.values()].map(policy => ({
        id: policy.id,
        name: policy.name,
        domain: policy.domain,
        scopeOptions: [...policy.scopeOptions],
        dependsOn: [...policy.dependsOn],
      }))
    },

    async deletePolicies(ids) {
      const idSet = new Set(ids)
      const deletedNames = new Set<string>()
      for (const policy of policies.values()) {
        if (idSet.has(policy.id)) deletedNames.add(policy.name)
      }
      for (const name of deletedNames) policies.delete(name)
      // S6: cascade into group entries and direct assignments.
      for (const [groupName, entries] of groupPolicies) {
        groupPolicies.set(
          groupName,
          entries.filter(entry => !deletedNames.has(entry.policyName)),
        )
      }
      removeWhere(directAssignments, assignment => deletedNames.has(assignment.policyName))
    },

    // ── Groups ───────────────────────────────────────────────────────────────

    async upsertGroup(group) {
      const existing = groups.get(group.name)
      if (existing) {
        // S7: update metadata, omitted optionals unchanged; entries untouched.
        existing.label = group.label
        if (group.description !== undefined) existing.description = group.description
        if (group.isSystem !== undefined) existing.isSystem = group.isSystem
        if (group.isActive !== undefined) existing.isActive = group.isActive
      } else {
        groups.set(group.name, {
          id: nextId(),
          name: group.name,
          label: group.label,
          description: group.description ?? '',
          isSystem: group.isSystem ?? false,
          isActive: group.isActive ?? true,
        })
        groupPolicies.set(group.name, [])
      }
    },

    async listGroups() {
      return [...groups.values()].map(group => ({
        id: group.id,
        name: group.name,
        label: group.label,
        isSystem: group.isSystem,
        isActive: group.isActive,
      }))
    },

    async getGroupPolicies(groupName) {
      return (groupPolicies.get(groupName) ?? []).map(entry => ({ ...entry }))
    },

    async setGroupPolicies(groupName, entries) {
      requireGroup(groupName)
      // S8: exact replacement, scoped to this group only.
      groupPolicies.set(
        groupName,
        entries.map(entry => ({ policyName: entry.policyName, scope: entry.scope })),
      )
    },

    async addGroupPolicies(groupName, entries) {
      requireGroup(groupName)
      const current = groupPolicies.get(groupName) ?? []
      for (const entry of entries) {
        // S9: additive and idempotent — an existing pair keeps its scope.
        if (!current.some(existing => existing.policyName === entry.policyName)) {
          current.push({ policyName: entry.policyName, scope: entry.scope })
        }
      }
      groupPolicies.set(groupName, current)
    },

    // ── Assignments ──────────────────────────────────────────────────────────

    async assignGroup(ref, groupName) {
      requireGroup(groupName)
      // S10: idempotent against the (subject, group, domain, tenantId) tuple.
      const exists = groupAssignments.some(
        assignment => sameTuple(assignment, ref) && assignment.groupName === groupName,
      )
      if (!exists) {
        groupAssignments.push({
          subjectId: ref.subjectId,
          domain: ref.domain,
          tenantId: ref.tenantId,
          groupName,
        })
      }
    },

    async removeGroup(ref, groupName) {
      // S11: only the exact tuple.
      removeWhere(
        groupAssignments,
        assignment => sameTuple(assignment, ref) && assignment.groupName === groupName,
      )
    },

    async assignPolicy(ref, policyName, scope) {
      if (!policies.has(policyName)) throw new UnknownPolicyError(policyName) // S12
      const existing = directAssignments.find(
        assignment => sameTuple(assignment, ref) && assignment.policyName === policyName,
      )
      if (existing) {
        existing.scope = scope ?? null // S10: upsert — one row, scope updated.
      } else {
        directAssignments.push({
          subjectId: ref.subjectId,
          domain: ref.domain,
          tenantId: ref.tenantId,
          policyName,
          scope: scope ?? null,
        })
      }
    },

    async removePolicy(ref, policyName) {
      removeWhere(
        directAssignments,
        assignment => sameTuple(assignment, ref) && assignment.policyName === policyName,
      )
    },

    // ── Enforcement hot path ─────────────────────────────────────────────────

    async getSubjectPolicies(ref) {
      // S3/S4: group grants then direct grants, each sorted by name, no dedup.
      const groupGrants: PolicyGrant[] = []
      for (const assignment of groupAssignments) {
        if (!sameTuple(assignment, ref)) continue
        const group = groups.get(assignment.groupName)
        if (!group || !group.isActive) continue
        for (const entry of groupPolicies.get(assignment.groupName) ?? []) {
          groupGrants.push({ name: entry.policyName, scope: entry.scope })
        }
      }
      groupGrants.sort(byName)

      const directGrants: PolicyGrant[] = directAssignments
        .filter(assignment => sameTuple(assignment, ref))
        .map(assignment => ({ name: assignment.policyName, scope: assignment.scope }))
        .sort(byName)

      return [...groupGrants, ...directGrants]
    },

    // ── Ownership ────────────────────────────────────────────────────────────

    async recordOwnership(entries) {
      for (const entry of entries) {
        const relation = entry.relation ?? 'owner' // S22: omitted relation is stored as 'owner'.
        // S22: upsert on (resourceType, resourceId, ownerId, relation).
        const existing = ownership.find(
          row =>
            row.resourceType === entry.resourceType &&
            row.resourceId === entry.resourceId &&
            row.ownerId === entry.ownerId &&
            row.relation === relation,
        )
        if (existing) {
          existing.domain = entry.domain
          existing.tenantId = entry.tenantId
        } else {
          ownership.push({ ...entry, relation })
        }
      }
    },

    async isOwner(ownerId, resource) {
      // S22: only relation-'owner' rows make isOwner true.
      return accessMatches(
        resource.type,
        resource.id,
        row => row.ownerId === ownerId && row.relation === 'owner',
      )
    },

    async removeOwnership(resource) {
      // S13: every entry for the resource, all relations.
      removeWhere(
        ownership,
        row => row.resourceType === resource.type && row.resourceId === resource.id,
      )
    },

    async getAccess(resource) {
      // S21: every entry, all relations, relation populated.
      return ownership
        .filter(row => row.resourceType === resource.type && row.resourceId === resource.id)
        .map(row => ({ ...row }))
    },

    async removeAccess(ownerId, resource, relation) {
      // S23: only the matching (ownerId, type, id[, relation]) entries.
      removeWhere(
        ownership,
        row =>
          row.resourceType === resource.type &&
          row.resourceId === resource.id &&
          row.ownerId === ownerId &&
          (relation === undefined || row.relation === relation),
      )
    },

    listFilters: {
      owned: (subjectId, resource) => ({
        where: ((row) =>
          accessMatches(
            resource.type,
            row.id,
            entry => entry.ownerId === subjectId && entry.relation === 'owner',
          )) satisfies MemoryWhere,
      }),
      inTenant: (tenantId, resource) => {
        // '' is the no-tenant sentinel — it must never match stored '' rows.
        if (tenantId === '') return false
        return {
          where: ((row) =>
            accessMatches(resource.type, row.id, entry => entry.tenantId === tenantId)) satisfies MemoryWhere,
        }
      },
      granted: (subjectId, resource) => ({
        where: ((row) =>
          accessMatches(
            resource.type,
            row.id,
            entry => entry.ownerId === subjectId && entry.relation === 'granted',
          )) satisfies MemoryWhere,
      }),
      or: fragments => {
        const predicates = fragments as MemoryWhere[]
        return ((row) => predicates.some(predicate => predicate(row))) satisfies MemoryWhere
      },
      none: () => (() => false) satisfies MemoryWhere,
    },
  }
}

function removeWhere<T>(items: T[], predicate: (item: T) => boolean): void {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) items.splice(index, 1)
  }
}
