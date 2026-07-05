import { UnknownPolicyError } from '../contract.js'
import type {
  GroupPolicyEntry,
  GroupRecord,
  OwnershipEntry,
  PolicyDefinitionRow,
  PolicyGrant,
  PolicyRecord,
  StorageAdapter,
} from '../contract.js'
import type { ResourceRef, SubjectRef } from '../../core/types.js'
import type { PrismaClientLike, PrismaRbacModelDelegates } from './client-contract.js'

/** Prisma's unique-constraint violation (PrismaClientKnownRequestError P2002). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }
  return []
}

function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

function byName(a: PolicyGrant, b: PolicyGrant): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * Prisma StorageAdapter.
 *
 * The client is structural (see ./client-contract.ts): pass any generated
 * `PrismaClient` whose schema contains the six models from
 * `prismaSchemaSnippet`. Lifecycle notes:
 *
 * - `ensureSchema` is omitted — Prisma migrations (`prisma migrate` /
 *   `prisma db push`) own DDL, exactly like the Drizzle adapter.
 * - `close` is omitted — the caller owns the client (`$disconnect()`).
 * - S10 under races: concurrent assigns on the same tuple can make the
 *   loser's `upsert` throw P2002; that is treated as success (assignGroup)
 *   or converted into the scope update the upsert would have run
 *   (assignPolicy), so idempotency holds under concurrency.
 */
export function prismaAdapter(client: PrismaClientLike): StorageAdapter {
  const findGroupId = async (
    ex: PrismaRbacModelDelegates,
    name: string,
  ): Promise<string | null> => {
    const group: { id: unknown } | null = await ex.rbacPolicyGroup.findUnique({
      where: { name },
      select: { id: true },
    })
    return group ? String(group.id) : null
  }

  const requireGroupId = async (ex: PrismaRbacModelDelegates, name: string): Promise<string> => {
    const id = await findGroupId(ex, name)
    if (id === null) throw new Error(`[rbac] Policy group "${name}" not found — seed groups first.`)
    return id
  }

  /** Resolves policy names → ids; throws UnknownPolicyError for the first unknown (S12). */
  const resolvePolicyIds = async (
    ex: PrismaRbacModelDelegates,
    names: string[],
  ): Promise<Map<string, string>> => {
    const unique = [...new Set(names)]
    if (unique.length === 0) return new Map()
    const rows: Array<{ id: unknown; name: unknown }> = await ex.rbacPolicy.findMany({
      where: { name: { in: unique } },
      select: { id: true, name: true },
    })
    const idByName = new Map(rows.map(row => [String(row.name), String(row.id)]))
    const unknown = unique.find(name => !idByName.has(name))
    if (unknown !== undefined) throw new UnknownPolicyError(unknown)
    return idByName
  }

  return {
    id: 'prisma',
    capabilities: { autoOwnershipTracking: true, queryScoping: false },

    async upsertPolicies(rows: PolicyDefinitionRow[]): Promise<void> {
      if (rows.length === 0) return
      await client.$transaction(async tx => {
        const existing: Array<{
          id: unknown
          name: unknown
          domain: unknown
          label: unknown
          scopeOptions: unknown
          dependsOn: unknown
        }> = await tx.rbacPolicy.findMany({
          where: { name: { in: rows.map(row => row.name) } },
          select: {
            id: true,
            name: true,
            domain: true,
            label: true,
            scopeOptions: true,
            dependsOn: true,
          },
        })
        const currentByName = new Map(existing.map(row => [String(row.name), row]))

        const missing: PolicyDefinitionRow[] = []
        for (const row of rows) {
          const current = currentByName.get(row.name)
          if (!current) {
            missing.push(row)
            continue
          }
          // S5/S15: metadata of an existing policy MUST be updated from the
          // incoming values — never a self-referential set.
          const changed =
            current.label !== row.label ||
            current.domain !== row.domain ||
            !sameArray(toStringArray(current.scopeOptions), row.scopeOptions) ||
            !sameArray(toStringArray(current.dependsOn), row.dependsOn)
          if (!changed) continue
          await tx.rbacPolicy.update({
            where: { id: String(current.id) },
            data: {
              domain: row.domain,
              label: row.label,
              scopeOptions: row.scopeOptions,
              dependsOn: row.dependsOn,
              updatedAt: new Date(),
            },
          })
        }

        if (missing.length > 0) {
          await tx.rbacPolicy.createMany({
            data: missing.map(row => ({
              name: row.name,
              domain: row.domain,
              label: row.label,
              scopeOptions: row.scopeOptions,
              dependsOn: row.dependsOn,
            })),
          })
        }
      })
    },

    async listPolicies(): Promise<PolicyRecord[]> {
      const rows: Array<{ id: unknown; name: unknown; domain: unknown; dependsOn: unknown }> =
        await client.rbacPolicy.findMany({
          orderBy: { name: 'asc' },
          select: { id: true, name: true, domain: true, dependsOn: true },
        })
      return rows.map(row => ({
        id: String(row.id),
        name: String(row.name),
        domain: String(row.domain ?? ''),
        dependsOn: toStringArray(row.dependsOn),
      }))
    },

    async deletePolicies(ids: string[]): Promise<void> {
      if (ids.length === 0) return
      // S6: cascade group entries and direct assignments atomically.
      await client.$transaction(async tx => {
        await tx.rbacPolicyGroupPolicy.deleteMany({ where: { policyId: { in: ids } } })
        await tx.rbacUserPolicy.deleteMany({ where: { policyId: { in: ids } } })
        await tx.rbacPolicy.deleteMany({ where: { id: { in: ids } } })
      })
    },

    async upsertGroup(group): Promise<void> {
      const existingId = await findGroupId(client, group.name)
      if (existingId === null) {
        try {
          await client.rbacPolicyGroup.create({
            data: {
              name: group.name,
              label: group.label,
              description: group.description ?? null,
              isSystem: group.isSystem ?? false,
              isActive: group.isActive ?? true,
            },
          })
          return
        } catch (error) {
          // Lost a create race on the unique name: fall through to update.
          if (!isUniqueViolation(error)) throw error
        }
      }
      // S7: omitted optional fields keep their stored value.
      const data: Record<string, unknown> = { label: group.label, updatedAt: new Date() }
      if (group.description !== undefined) data['description'] = group.description
      if (group.isSystem !== undefined) data['isSystem'] = group.isSystem
      if (group.isActive !== undefined) data['isActive'] = group.isActive
      await client.rbacPolicyGroup.update({ where: { name: group.name }, data })
    },

    async listGroups(): Promise<GroupRecord[]> {
      const rows: Array<{
        id: unknown
        name: unknown
        label: unknown
        isSystem: unknown
        isActive: unknown
      }> = await client.rbacPolicyGroup.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, label: true, isSystem: true, isActive: true },
      })
      return rows.map(row => ({
        id: String(row.id),
        name: String(row.name),
        label: String(row.label),
        isSystem: Boolean(row.isSystem),
        isActive: Boolean(row.isActive),
      }))
    },

    async getGroupPolicies(groupName: string): Promise<GroupPolicyEntry[]> {
      const rows: Array<{ scope: unknown; policy: { name: unknown } }> =
        await client.rbacPolicyGroupPolicy.findMany({
          where: { policyGroup: { is: { name: groupName } } },
          select: { scope: true, policy: { select: { name: true } } },
        })
      return rows
        .map(row => ({
          policyName: String(row.policy.name),
          scope: (row.scope as string | null) ?? null,
        }))
        .sort((a, b) => (a.policyName < b.policyName ? -1 : a.policyName > b.policyName ? 1 : 0))
    },

    async setGroupPolicies(groupName: string, entries: GroupPolicyEntry[]): Promise<void> {
      // S8: replace exactly — remove absent, add missing, update changed
      // scopes — all inside one transaction, touching only this group.
      await client.$transaction(async tx => {
        const groupId = await requireGroupId(tx, groupName)
        const idByName = await resolvePolicyIds(tx, entries.map(entry => entry.policyName))
        const keepIds = [...idByName.values()]

        await tx.rbacPolicyGroupPolicy.deleteMany({
          where:
            keepIds.length > 0
              ? { policyGroupId: groupId, policyId: { notIn: keepIds } }
              : { policyGroupId: groupId },
        })

        const existingRows: Array<{ policyId: unknown; scope: unknown }> =
          await tx.rbacPolicyGroupPolicy.findMany({
            where: { policyGroupId: groupId },
            select: { policyId: true, scope: true },
          })
        const existingScopeByPolicy = new Map(
          existingRows.map(row => [String(row.policyId), (row.scope as string | null) ?? null]),
        )

        const toCreate: Array<{ policyGroupId: string; policyId: string; scope: string | null }> = []
        const applied = new Set<string>()
        for (const entry of entries) {
          const policyId = idByName.get(entry.policyName)!
          if (applied.has(policyId)) continue
          applied.add(policyId)
          const scope = entry.scope ?? null
          if (!existingScopeByPolicy.has(policyId)) {
            toCreate.push({ policyGroupId: groupId, policyId, scope })
          } else if (existingScopeByPolicy.get(policyId) !== scope) {
            await tx.rbacPolicyGroupPolicy.updateMany({
              where: { policyGroupId: groupId, policyId },
              data: { scope },
            })
          }
        }
        if (toCreate.length > 0) {
          await tx.rbacPolicyGroupPolicy.createMany({ data: toCreate })
        }
      })
    },

    async addGroupPolicies(groupName: string, entries: GroupPolicyEntry[]): Promise<void> {
      if (entries.length === 0) return
      // S9: additive and idempotent — existing pairs keep their scope.
      await client.$transaction(async tx => {
        const groupId = await requireGroupId(tx, groupName)
        const idByName = await resolvePolicyIds(tx, entries.map(entry => entry.policyName))

        const existingRows: Array<{ policyId: unknown }> = await tx.rbacPolicyGroupPolicy.findMany(
          {
            where: { policyGroupId: groupId },
            select: { policyId: true },
          },
        )
        const existingIds = new Set(existingRows.map(row => String(row.policyId)))

        const toCreate: Array<{ policyGroupId: string; policyId: string; scope: string | null }> = []
        for (const entry of entries) {
          const policyId = idByName.get(entry.policyName)!
          if (existingIds.has(policyId)) continue
          existingIds.add(policyId)
          toCreate.push({ policyGroupId: groupId, policyId, scope: entry.scope ?? null })
        }
        if (toCreate.length > 0) {
          await tx.rbacPolicyGroupPolicy.createMany({ data: toCreate })
        }
      })
    },

    async assignGroup(ref: SubjectRef, groupName: string): Promise<void> {
      const groupId = await requireGroupId(client, groupName)
      try {
        await client.rbacUserPolicyGroup.upsert({
          where: {
            subjectId_policyGroupId_domain_tenantId: {
              subjectId: ref.subjectId,
              policyGroupId: groupId,
              domain: ref.domain,
              tenantId: ref.tenantId,
            },
          },
          update: {},
          create: {
            subjectId: ref.subjectId,
            policyGroupId: groupId,
            domain: ref.domain,
            tenantId: ref.tenantId,
          },
        })
      } catch (error) {
        // S10 race: a concurrent assign inserted the same tuple first; the
        // unique constraint makes the loser's P2002 equivalent to success.
        if (!isUniqueViolation(error)) throw error
      }
    },

    async removeGroup(ref: SubjectRef, groupName: string): Promise<void> {
      const groupId = await findGroupId(client, groupName)
      if (groupId === null) return
      // S11: exact-tuple removal only.
      await client.rbacUserPolicyGroup.deleteMany({
        where: {
          subjectId: ref.subjectId,
          policyGroupId: groupId,
          domain: ref.domain,
          tenantId: ref.tenantId,
        },
      })
    },

    async assignPolicy(ref: SubjectRef, policyName: string, scope?: string | null): Promise<void> {
      const policy: { id: unknown } | null = await client.rbacPolicy.findUnique({
        where: { name: policyName },
        select: { id: true },
      })
      if (!policy) throw new UnknownPolicyError(policyName)
      const policyId = String(policy.id)
      const next = scope ?? null
      try {
        await client.rbacUserPolicy.upsert({
          where: {
            subjectId_policyId_domain_tenantId: {
              subjectId: ref.subjectId,
              policyId,
              domain: ref.domain,
              tenantId: ref.tenantId,
            },
          },
          update: { scope: next },
          create: {
            subjectId: ref.subjectId,
            policyId,
            domain: ref.domain,
            tenantId: ref.tenantId,
            scope: next,
          },
        })
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        // S10 race: the row exists now — apply the scope the upsert carried.
        await client.rbacUserPolicy.updateMany({
          where: {
            subjectId: ref.subjectId,
            policyId,
            domain: ref.domain,
            tenantId: ref.tenantId,
          },
          data: { scope: next },
        })
      }
    },

    async removePolicy(ref: SubjectRef, policyName: string): Promise<void> {
      const policy: { id: unknown } | null = await client.rbacPolicy.findUnique({
        where: { name: policyName },
        select: { id: true },
      })
      if (!policy) return
      // S11: exact-tuple removal only.
      await client.rbacUserPolicy.deleteMany({
        where: {
          subjectId: ref.subjectId,
          policyId: String(policy.id),
          domain: ref.domain,
          tenantId: ref.tenantId,
        },
      })
    },

    async getSubjectPolicies(ref: SubjectRef): Promise<PolicyGrant[]> {
      // S2/S3: strict equality on (subjectId, domain, tenantId) for BOTH paths.
      const tuple = { subjectId: ref.subjectId, domain: ref.domain, tenantId: ref.tenantId }

      const assignments: Array<{
        policyGroup: { entries: Array<{ scope: unknown; policy: { name: unknown } }> }
      }> = await client.rbacUserPolicyGroup.findMany({
        // S20: deactivated groups grant nothing.
        where: { ...tuple, policyGroup: { is: { isActive: true } } },
        select: {
          policyGroup: {
            select: {
              entries: { select: { scope: true, policy: { select: { name: true } } } },
            },
          },
        },
      })
      const groupGrants: PolicyGrant[] = []
      for (const assignment of assignments) {
        for (const entry of assignment.policyGroup.entries) {
          groupGrants.push({
            name: String(entry.policy.name),
            scope: (entry.scope as string | null) ?? null,
          })
        }
      }

      const direct: Array<{ scope: unknown; policy: { name: unknown } }> =
        await client.rbacUserPolicy.findMany({
          where: tuple,
          select: { scope: true, policy: { select: { name: true } } },
        })
      const directGrants: PolicyGrant[] = direct.map(row => ({
        name: String(row.policy.name),
        scope: (row.scope as string | null) ?? null,
      }))

      // S4: no dedup; group grants first, then direct, each sorted by name.
      return [...groupGrants.sort(byName), ...directGrants.sort(byName)]
    },

    async recordOwnership(entries: OwnershipEntry[]): Promise<void> {
      if (entries.length === 0) return
      for (const entry of entries) {
        try {
          // S13: upsert on (resourceType, resourceId, ownerId); last write
          // wins on the domain/tenant fields.
          await client.rbacResourceOwner.upsert({
            where: {
              resourceType_resourceId_ownerId: {
                resourceType: entry.resourceType,
                resourceId: entry.resourceId,
                ownerId: entry.ownerId,
              },
            },
            update: { domain: entry.domain, tenantId: entry.tenantId },
            create: {
              resourceType: entry.resourceType,
              resourceId: entry.resourceId,
              ownerId: entry.ownerId,
              domain: entry.domain,
              tenantId: entry.tenantId,
            },
          })
        } catch (error) {
          // Concurrent record of the same (type, id, owner): loser's P2002 ≡ success.
          if (!isUniqueViolation(error)) throw error
        }
      }
    },

    async isOwner(ownerId: string, resource: ResourceRef): Promise<boolean> {
      const row: { id: unknown } | null = await client.rbacResourceOwner.findFirst({
        where: { ownerId, resourceType: resource.type, resourceId: resource.id },
        select: { id: true },
      })
      return row !== null
    },

    async removeOwnership(resource: ResourceRef): Promise<void> {
      await client.rbacResourceOwner.deleteMany({
        where: { resourceType: resource.type, resourceId: resource.id },
      })
    },
  }
}
