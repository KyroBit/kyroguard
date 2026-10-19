import { UnknownPolicyError } from '../contract.js'
import type {
  GroupPolicyEntry,
  GroupRecord,
  PolicyDefinitionRow,
  PolicyGrant,
  PolicyRecord,
  StorageAdapter,
} from '../contract.js'
import type { SubjectRef } from '../../core/types.js'
import type { PrismaClientLike, PrismaKyroguardModelDelegates } from './client-contract.js'

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
 * Prisma StorageAdapter. The client is structural (see ./client-contract.ts);
 * ensureSchema is omitted — migrations own DDL. close() disconnects the
 * client (a disconnected Prisma client reconnects on its next query).
 */
export function prismaAdapter(client: PrismaClientLike): StorageAdapter {
  const findGroupId = async (
    ex: PrismaKyroguardModelDelegates,
    name: string,
  ): Promise<string | null> => {
    const group: { id: unknown } | null = await ex.kyroguardPolicyGroup.findUnique({
      where: { name },
      select: { id: true },
    })
    return group ? String(group.id) : null
  }

  const requireGroupId = async (ex: PrismaKyroguardModelDelegates, name: string): Promise<string> => {
    const id = await findGroupId(ex, name)
    if (id === null) throw new Error(`[kyroguard] Policy group "${name}" not found — seed groups first.`)
    return id
  }

  /** Resolves policy names → ids; throws UnknownPolicyError for the first unknown (S12). */
  const resolvePolicyIds = async (
    ex: PrismaKyroguardModelDelegates,
    names: string[],
  ): Promise<Map<string, string>> => {
    const unique = [...new Set(names)]
    if (unique.length === 0) return new Map()
    const rows: Array<{ id: unknown; name: unknown }> = await ex.kyroguardPolicy.findMany({
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
    capabilities: { listFiltering: true },

    async close(): Promise<void> {
      await client.$disconnect()
    },

    listFilters: {
      or: fragments => ({ OR: fragments }),
      // Field-level, not `OR: []` or `NOT: {}`: inside a WhereUniqueInput
      // Prisma folds those away to no condition at all, and a denied
      // update/delete would write the row.
      none: () => ({ id: { in: [] } }),
    },

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
        }> = await tx.kyroguardPolicy.findMany({
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
          await tx.kyroguardPolicy.update({
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
          await tx.kyroguardPolicy.createMany({
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
      const rows: Array<{
        id: unknown
        name: unknown
        domain: unknown
        scopeOptions: unknown
        dependsOn: unknown
      }> = await client.kyroguardPolicy.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, domain: true, scopeOptions: true, dependsOn: true },
      })
      return rows.map(row => ({
        id: String(row.id),
        name: String(row.name),
        domain: String(row.domain ?? ''),
        scopeOptions: toStringArray(row.scopeOptions),
        dependsOn: toStringArray(row.dependsOn),
      }))
    },

    async deletePolicies(ids: string[]): Promise<void> {
      if (ids.length === 0) return
      // S6: cascade group entries and direct assignments atomically.
      await client.$transaction(async tx => {
        await tx.kyroguardPolicyGroupPolicy.deleteMany({ where: { policyId: { in: ids } } })
        await tx.kyroguardUserPolicy.deleteMany({ where: { policyId: { in: ids } } })
        await tx.kyroguardPolicy.deleteMany({ where: { id: { in: ids } } })
      })
    },

    async upsertGroup(group): Promise<void> {
      const existingId = await findGroupId(client, group.name)
      if (existingId === null) {
        try {
          await client.kyroguardPolicyGroup.create({
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
      await client.kyroguardPolicyGroup.update({ where: { name: group.name }, data })
    },

    async listGroups(): Promise<GroupRecord[]> {
      const rows: Array<{
        id: unknown
        name: unknown
        label: unknown
        isSystem: unknown
        isActive: unknown
      }> = await client.kyroguardPolicyGroup.findMany({
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
        await client.kyroguardPolicyGroupPolicy.findMany({
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
      // S8: replace exactly, in one transaction, touching only this group.
      await client.$transaction(async tx => {
        const groupId = await requireGroupId(tx, groupName)
        const idByName = await resolvePolicyIds(tx, entries.map(entry => entry.policyName))
        const keepIds = [...idByName.values()]

        await tx.kyroguardPolicyGroupPolicy.deleteMany({
          where:
            keepIds.length > 0
              ? { policyGroupId: groupId, policyId: { notIn: keepIds } }
              : { policyGroupId: groupId },
        })

        const existingRows: Array<{ policyId: unknown; scope: unknown }> =
          await tx.kyroguardPolicyGroupPolicy.findMany({
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
            await tx.kyroguardPolicyGroupPolicy.updateMany({
              where: { policyGroupId: groupId, policyId },
              data: { scope },
            })
          }
        }
        if (toCreate.length > 0) {
          await tx.kyroguardPolicyGroupPolicy.createMany({ data: toCreate })
        }
      })
    },

    async addGroupPolicies(groupName: string, entries: GroupPolicyEntry[]): Promise<void> {
      if (entries.length === 0) return
      // S9: additive and idempotent — existing pairs keep their scope.
      await client.$transaction(async tx => {
        const groupId = await requireGroupId(tx, groupName)
        const idByName = await resolvePolicyIds(tx, entries.map(entry => entry.policyName))

        const existingRows: Array<{ policyId: unknown }> = await tx.kyroguardPolicyGroupPolicy.findMany(
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
          await tx.kyroguardPolicyGroupPolicy.createMany({ data: toCreate })
        }
      })
    },

    async assignGroup(ref: SubjectRef, groupName: string): Promise<void> {
      const groupId = await requireGroupId(client, groupName)
      try {
        await client.kyroguardUserPolicyGroup.upsert({
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
        // S10 race: loser's P2002 on the same tuple is equivalent to success.
        if (!isUniqueViolation(error)) throw error
      }
    },

    async removeGroup(ref: SubjectRef, groupName: string): Promise<void> {
      const groupId = await findGroupId(client, groupName)
      if (groupId === null) return
      // S11: exact-tuple removal only.
      await client.kyroguardUserPolicyGroup.deleteMany({
        where: {
          subjectId: ref.subjectId,
          policyGroupId: groupId,
          domain: ref.domain,
          tenantId: ref.tenantId,
        },
      })
    },

    async assignPolicy(ref: SubjectRef, policyName: string, scope?: string | null): Promise<void> {
      const policy: { id: unknown } | null = await client.kyroguardPolicy.findUnique({
        where: { name: policyName },
        select: { id: true },
      })
      if (!policy) throw new UnknownPolicyError(policyName)
      const policyId = String(policy.id)
      const next = scope ?? null
      try {
        await client.kyroguardUserPolicy.upsert({
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
        await client.kyroguardUserPolicy.updateMany({
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
      const policy: { id: unknown } | null = await client.kyroguardPolicy.findUnique({
        where: { name: policyName },
        select: { id: true },
      })
      if (!policy) return
      // S11: exact-tuple removal only.
      await client.kyroguardUserPolicy.deleteMany({
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
      }> = await client.kyroguardUserPolicyGroup.findMany({
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
        await client.kyroguardUserPolicy.findMany({
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

    async getSubjectGroups(ref: SubjectRef): Promise<GroupRecord[]> {
      const rows: Array<{
        policyGroup: {
          id: unknown
          name: unknown
          label: unknown
          isSystem: unknown
          isActive: unknown
        }
      }> = await client.kyroguardUserPolicyGroup.findMany({
        where: { subjectId: ref.subjectId, domain: ref.domain, tenantId: ref.tenantId },
        orderBy: { policyGroup: { name: 'asc' } },
        select: {
          policyGroup: {
            select: { id: true, name: true, label: true, isSystem: true, isActive: true },
          },
        },
      })

      return rows.map(row => ({
        id: String(row.policyGroup.id),
        name: String(row.policyGroup.name),
        label: String(row.policyGroup.label),
        isSystem: Boolean(row.policyGroup.isSystem),
        isActive: Boolean(row.policyGroup.isActive),
      }))
    },
  }
}
