import { and, asc, eq, inArray, notInArray } from 'drizzle-orm'
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

export type DrizzleDialect = 'pg' | 'mysql' | 'sqlite'

/** The `tables` barrel exported by `@kyrobit/rbac/drizzle/schema/{pg,mysql,sqlite}`. */
export interface DrizzleRbacTables {
  policies: unknown
  policyGroups: unknown
  policyGroupPolicies: unknown
  userPolicyGroups: unknown
  userPolicies: unknown
  resourceOwners: unknown
}

/** Pass the whole schema module: `import * as schema from '@kyrobit/rbac/drizzle/schema/pg'`. */
export interface DrizzleRbacSchema {
  dialect: DrizzleDialect
  tables: DrizzleRbacTables
}

export interface DrizzleAdapterOptions {
  schema: DrizzleRbacSchema
}

export interface DrizzleStorageAdapter extends StorageAdapter {
  /**
   * Internal hook for trackedDb: write ownership rows through a specific
   * executor (the surrounding transaction) so they commit atomically with the
   * tracked resource insert.
   */
  recordOwnershipWith(executor: unknown, entries: OwnershipEntry[]): Promise<void>
}

// The three dialects' table and database types share a runtime shape but do
// not unify statically; this adapter is dialect-generic, so the db handle and
// table columns are this module's single `any` boundary.
type Db = any
interface Tables {
  policies: any
  policyGroups: any
  policyGroupPolicies: any
  userPolicyGroups: any
  userPolicies: any
  resourceOwners: any
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

export function drizzleAdapter(db: unknown, options: DrizzleAdapterOptions): DrizzleStorageAdapter {
  const client = db as Db
  const t = options.schema.tables as Tables

  const findGroupId = async (ex: Db, name: string): Promise<string | null> => {
    const rows = await ex
      .select({ id: t.policyGroups.id })
      .from(t.policyGroups)
      .where(eq(t.policyGroups.name, name))
      .limit(1)
    return rows.length ? String(rows[0].id) : null
  }

  const requireGroupId = async (ex: Db, name: string): Promise<string> => {
    const id = await findGroupId(ex, name)
    if (id === null) throw new Error(`[rbac] Policy group "${name}" not found — seed groups first.`)
    return id
  }

  const findPolicyId = async (ex: Db, name: string): Promise<string | null> => {
    const rows = await ex
      .select({ id: t.policies.id })
      .from(t.policies)
      .where(eq(t.policies.name, name))
      .limit(1)
    return rows.length ? String(rows[0].id) : null
  }

  const writeOwnership = async (ex: Db, entries: OwnershipEntry[]): Promise<void> => {
    for (const entry of entries) {
      const existing = await ex
        .select({ id: t.resourceOwners.id })
        .from(t.resourceOwners)
        .where(
          and(
            eq(t.resourceOwners.resourceType, entry.resourceType),
            eq(t.resourceOwners.resourceId, entry.resourceId),
            eq(t.resourceOwners.ownerId, entry.ownerId),
          ),
        )
        .limit(1)
      if (existing.length) continue
      await ex.insert(t.resourceOwners).values({
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        ownerId: entry.ownerId,
        contextType: entry.contextType,
        contextId: entry.contextId,
      })
    }
  }

  return {
    id: `drizzle-${options.schema.dialect}`,
    capabilities: { autoOwnershipTracking: true, queryScoping: true },

    async upsertPolicies(rows: PolicyDefinitionRow[]): Promise<void> {
      if (!rows.length) return
      await client.transaction(async (tx: Db) => {
        const existing = await tx
          .select({
            id: t.policies.id,
            name: t.policies.name,
            portal: t.policies.portal,
            label: t.policies.label,
            scopeOptions: t.policies.scopeOptions,
            dependsOn: t.policies.dependsOn,
          })
          .from(t.policies)
          .where(inArray(t.policies.name, rows.map(r => r.name)))
        const byName = new Map<string, any>(existing.map((r: any) => [String(r.name), r]))

        for (const row of rows) {
          const current = byName.get(row.name)
          if (!current) {
            await tx.insert(t.policies).values({
              name: row.name,
              portal: row.portal,
              label: row.label,
              scopeOptions: row.scopeOptions,
              dependsOn: row.dependsOn,
            })
            continue
          }
          const changed =
            current.label !== row.label ||
            current.portal !== row.portal ||
            !sameArray(toStringArray(current.scopeOptions), row.scopeOptions) ||
            !sameArray(toStringArray(current.dependsOn), row.dependsOn)
          if (!changed) continue
          await tx
            .update(t.policies)
            .set({
              portal: row.portal,
              label: row.label,
              scopeOptions: row.scopeOptions,
              dependsOn: row.dependsOn,
              updatedAt: new Date(),
            })
            .where(eq(t.policies.id, current.id))
        }
      })
    },

    async listPolicies(): Promise<PolicyRecord[]> {
      const rows = await client
        .select({
          id: t.policies.id,
          name: t.policies.name,
          portal: t.policies.portal,
          dependsOn: t.policies.dependsOn,
        })
        .from(t.policies)
        .orderBy(asc(t.policies.name))
      return rows.map((r: any) => ({
        id: String(r.id),
        name: String(r.name),
        portal: String(r.portal ?? ''),
        dependsOn: toStringArray(r.dependsOn),
      }))
    },

    async deletePolicies(ids: string[]): Promise<void> {
      if (!ids.length) return
      await client.transaction(async (tx: Db) => {
        await tx.delete(t.policyGroupPolicies).where(inArray(t.policyGroupPolicies.policyId, ids))
        await tx.delete(t.userPolicies).where(inArray(t.userPolicies.policyId, ids))
        await tx.delete(t.policies).where(inArray(t.policies.id, ids))
      })
    },

    async upsertGroup(group): Promise<void> {
      await client.transaction(async (tx: Db) => {
        const rows = await tx
          .select({ id: t.policyGroups.id })
          .from(t.policyGroups)
          .where(eq(t.policyGroups.name, group.name))
          .limit(1)
        if (!rows.length) {
          await tx.insert(t.policyGroups).values({
            name: group.name,
            label: group.label,
            description: group.description ?? null,
            isSystem: group.isSystem ?? false,
            isActive: group.isActive ?? true,
          })
          return
        }
        // S7: omitted optional fields keep their stored value.
        const set: Record<string, unknown> = { label: group.label, updatedAt: new Date() }
        if (group.description !== undefined) set['description'] = group.description
        if (group.isSystem !== undefined) set['isSystem'] = group.isSystem
        if (group.isActive !== undefined) set['isActive'] = group.isActive
        await tx.update(t.policyGroups).set(set).where(eq(t.policyGroups.id, rows[0].id))
      })
    },

    async listGroups(): Promise<GroupRecord[]> {
      const rows = await client
        .select({
          id: t.policyGroups.id,
          name: t.policyGroups.name,
          label: t.policyGroups.label,
          isSystem: t.policyGroups.isSystem,
          isActive: t.policyGroups.isActive,
        })
        .from(t.policyGroups)
        .orderBy(asc(t.policyGroups.name))
      return rows.map((r: any) => ({
        id: String(r.id),
        name: String(r.name),
        label: String(r.label),
        isSystem: Boolean(r.isSystem),
        isActive: Boolean(r.isActive),
      }))
    },

    async getGroupPolicies(groupName: string): Promise<GroupPolicyEntry[]> {
      const rows = await client
        .select({ name: t.policies.name, scope: t.policyGroupPolicies.scope })
        .from(t.policyGroupPolicies)
        .innerJoin(t.policyGroups, eq(t.policyGroups.id, t.policyGroupPolicies.policyGroupId))
        .innerJoin(t.policies, eq(t.policies.id, t.policyGroupPolicies.policyId))
        .where(eq(t.policyGroups.name, groupName))
        .orderBy(asc(t.policies.name))
      return rows.map((r: any) => ({ policyName: String(r.name), scope: (r.scope as string | null) ?? null }))
    },

    async setGroupPolicies(groupName: string, entries: GroupPolicyEntry[]): Promise<void> {
      await client.transaction(async (tx: Db) => {
        const groupId = await requireGroupId(tx, groupName)
        const names = [...new Set(entries.map(e => e.policyName))]
        const policyRows: any[] = names.length
          ? await tx
              .select({ id: t.policies.id, name: t.policies.name })
              .from(t.policies)
              .where(inArray(t.policies.name, names))
          : []
        const idByName = new Map<string, string>(policyRows.map((r: any) => [String(r.name), String(r.id)]))
        const unknown = names.find(name => !idByName.has(name))
        if (unknown !== undefined) throw new UnknownPolicyError(unknown)

        const existingRows = await tx
          .select({ policyId: t.policyGroupPolicies.policyId, scope: t.policyGroupPolicies.scope })
          .from(t.policyGroupPolicies)
          .where(eq(t.policyGroupPolicies.policyGroupId, groupId))
        const existingScopeByPolicy = new Map<string, string | null>(
          existingRows.map((r: any) => [String(r.policyId), (r.scope as string | null) ?? null]),
        )

        const keepIds = names.map(name => idByName.get(name)!)
        if (!keepIds.length) {
          await tx.delete(t.policyGroupPolicies).where(eq(t.policyGroupPolicies.policyGroupId, groupId))
        } else {
          await tx
            .delete(t.policyGroupPolicies)
            .where(
              and(
                eq(t.policyGroupPolicies.policyGroupId, groupId),
                notInArray(t.policyGroupPolicies.policyId, keepIds),
              ),
            )
        }

        const applied = new Set<string>()
        for (const entry of entries) {
          const policyId = idByName.get(entry.policyName)!
          if (applied.has(policyId)) continue
          applied.add(policyId)
          const scope = entry.scope ?? null
          if (!existingScopeByPolicy.has(policyId)) {
            await tx.insert(t.policyGroupPolicies).values({ policyGroupId: groupId, policyId, scope })
          } else if (existingScopeByPolicy.get(policyId) !== scope) {
            await tx
              .update(t.policyGroupPolicies)
              .set({ scope })
              .where(
                and(
                  eq(t.policyGroupPolicies.policyGroupId, groupId),
                  eq(t.policyGroupPolicies.policyId, policyId),
                ),
              )
          }
        }
      })
    },

    async addGroupPolicies(groupName: string, entries: GroupPolicyEntry[]): Promise<void> {
      if (!entries.length) return
      await client.transaction(async (tx: Db) => {
        const groupId = await requireGroupId(tx, groupName)
        const names = [...new Set(entries.map(e => e.policyName))]
        const policyRows: any[] = await tx
          .select({ id: t.policies.id, name: t.policies.name })
          .from(t.policies)
          .where(inArray(t.policies.name, names))
        const idByName = new Map<string, string>(policyRows.map((r: any) => [String(r.name), String(r.id)]))
        const unknown = names.find(name => !idByName.has(name))
        if (unknown !== undefined) throw new UnknownPolicyError(unknown)

        const existingRows = await tx
          .select({ policyId: t.policyGroupPolicies.policyId })
          .from(t.policyGroupPolicies)
          .where(eq(t.policyGroupPolicies.policyGroupId, groupId))
        const existingIds = new Set<string>(existingRows.map((r: any) => String(r.policyId)))

        for (const entry of entries) {
          const policyId = idByName.get(entry.policyName)!
          if (existingIds.has(policyId)) continue
          existingIds.add(policyId)
          await tx.insert(t.policyGroupPolicies).values({
            policyGroupId: groupId,
            policyId,
            scope: entry.scope ?? null,
          })
        }
      })
    },

    async assignGroup(ref: SubjectRef, groupName: string): Promise<void> {
      await client.transaction(async (tx: Db) => {
        const groupId = await requireGroupId(tx, groupName)
        const existing = await tx
          .select({ id: t.userPolicyGroups.id })
          .from(t.userPolicyGroups)
          .where(
            and(
              eq(t.userPolicyGroups.subjectId, ref.subjectId),
              eq(t.userPolicyGroups.policyGroupId, groupId),
              eq(t.userPolicyGroups.portal, ref.portal),
              eq(t.userPolicyGroups.contextId, ref.contextId),
            ),
          )
          .limit(1)
        if (existing.length) return
        await tx.insert(t.userPolicyGroups).values({
          subjectId: ref.subjectId,
          policyGroupId: groupId,
          portal: ref.portal,
          contextId: ref.contextId,
        })
      })
    },

    async removeGroup(ref: SubjectRef, groupName: string): Promise<void> {
      const groupId = await findGroupId(client, groupName)
      if (groupId === null) return
      await client
        .delete(t.userPolicyGroups)
        .where(
          and(
            eq(t.userPolicyGroups.subjectId, ref.subjectId),
            eq(t.userPolicyGroups.policyGroupId, groupId),
            eq(t.userPolicyGroups.portal, ref.portal),
            eq(t.userPolicyGroups.contextId, ref.contextId),
          ),
        )
    },

    async assignPolicy(ref: SubjectRef, policyName: string, scope?: string | null): Promise<void> {
      await client.transaction(async (tx: Db) => {
        const policyId = await findPolicyId(tx, policyName)
        if (policyId === null) throw new UnknownPolicyError(policyName)
        const next = scope ?? null
        const existing = await tx
          .select({ id: t.userPolicies.id, scope: t.userPolicies.scope })
          .from(t.userPolicies)
          .where(
            and(
              eq(t.userPolicies.subjectId, ref.subjectId),
              eq(t.userPolicies.policyId, policyId),
              eq(t.userPolicies.portal, ref.portal),
              eq(t.userPolicies.contextId, ref.contextId),
            ),
          )
          .limit(1)
        if (!existing.length) {
          await tx.insert(t.userPolicies).values({
            subjectId: ref.subjectId,
            policyId,
            portal: ref.portal,
            contextId: ref.contextId,
            scope: next,
          })
          return
        }
        if (((existing[0].scope as string | null) ?? null) !== next) {
          await tx.update(t.userPolicies).set({ scope: next }).where(eq(t.userPolicies.id, existing[0].id))
        }
      })
    },

    async removePolicy(ref: SubjectRef, policyName: string): Promise<void> {
      const policyId = await findPolicyId(client, policyName)
      if (policyId === null) return
      await client
        .delete(t.userPolicies)
        .where(
          and(
            eq(t.userPolicies.subjectId, ref.subjectId),
            eq(t.userPolicies.policyId, policyId),
            eq(t.userPolicies.portal, ref.portal),
            eq(t.userPolicies.contextId, ref.contextId),
          ),
        )
    },

    async getSubjectPolicies(ref: SubjectRef): Promise<PolicyGrant[]> {
      const groupGrants = await client
        .select({ name: t.policies.name, scope: t.policyGroupPolicies.scope })
        .from(t.userPolicyGroups)
        .innerJoin(t.policyGroups, eq(t.policyGroups.id, t.userPolicyGroups.policyGroupId))
        .innerJoin(
          t.policyGroupPolicies,
          eq(t.policyGroupPolicies.policyGroupId, t.userPolicyGroups.policyGroupId),
        )
        .innerJoin(t.policies, eq(t.policies.id, t.policyGroupPolicies.policyId))
        .where(
          and(
            eq(t.userPolicyGroups.subjectId, ref.subjectId),
            eq(t.userPolicyGroups.portal, ref.portal),
            eq(t.userPolicyGroups.contextId, ref.contextId),
            // S20: deactivated groups grant nothing.
            eq(t.policyGroups.isActive, true),
          ),
        )
        .orderBy(asc(t.policies.name))

      const directGrants = await client
        .select({ name: t.policies.name, scope: t.userPolicies.scope })
        .from(t.userPolicies)
        .innerJoin(t.policies, eq(t.policies.id, t.userPolicies.policyId))
        .where(
          and(
            eq(t.userPolicies.subjectId, ref.subjectId),
            eq(t.userPolicies.portal, ref.portal),
            eq(t.userPolicies.contextId, ref.contextId),
          ),
        )
        .orderBy(asc(t.policies.name))

      return [...groupGrants, ...directGrants].map((r: any) => ({
        name: String(r.name),
        scope: (r.scope as string | null) ?? null,
      }))
    },

    async recordOwnership(entries: OwnershipEntry[]): Promise<void> {
      if (!entries.length) return
      await client.transaction(async (tx: Db) => {
        await writeOwnership(tx, entries)
      })
    },

    async recordOwnershipWith(executor: unknown, entries: OwnershipEntry[]): Promise<void> {
      if (!entries.length) return
      await writeOwnership(executor as Db, entries)
    },

    async isOwner(ownerId: string, resource: ResourceRef): Promise<boolean> {
      const rows = await client
        .select({ id: t.resourceOwners.id })
        .from(t.resourceOwners)
        .where(
          and(
            eq(t.resourceOwners.ownerId, ownerId),
            eq(t.resourceOwners.resourceType, resource.type),
            eq(t.resourceOwners.resourceId, resource.id),
          ),
        )
        .limit(1)
      return rows.length > 0
    },

    async removeOwnership(resource: ResourceRef): Promise<void> {
      await client
        .delete(t.resourceOwners)
        .where(
          and(
            eq(t.resourceOwners.resourceType, resource.type),
            eq(t.resourceOwners.resourceId, resource.id),
          ),
        )
    },
  }
}
