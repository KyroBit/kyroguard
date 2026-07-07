import { UnknownPolicyError } from '../contract.js'
import { rbacModels } from './models.js'
import type { Connection, Types } from 'mongoose'
import type { ResourceRef, SubjectRef } from '../../core/types.js'
import type { ResourceDefinition } from '../../core/policy.js'
import type {
  GroupPolicyEntry,
  GroupRecord,
  OwnershipEntry,
  PolicyDefinitionRow,
  PolicyGrant,
  PolicyRecord,
  StorageAdapter,
} from '../contract.js'
import type { RbacModels } from './models.js'

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  )
}

function byName(a: PolicyGrant, b: PolicyGrant): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * Mongoose StorageAdapter; the caller owns the connection lifecycle.
 * deletePolicies deletes in dependency order (entries and assignments first)
 * so a partial failure never leaves assignments pointing at deleted policies.
 */
export function mongooseAdapter(connection: Connection): StorageAdapter {
  const models: RbacModels = rbacModels(connection)

  async function resolvePolicyIds(names: string[]): Promise<Map<string, Types.ObjectId>> {
    const unique = [...new Set(names)]
    if (unique.length === 0) return new Map()
    const docs = await models.policy.find({ name: { $in: unique } }).lean()
    const map = new Map(docs.map(doc => [doc.name, doc._id]))
    for (const name of unique) {
      if (!map.has(name)) throw new UnknownPolicyError(name)
    }
    return map
  }

  async function policyNamesById(ids: Types.ObjectId[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map()
    const docs = await models.policy.find({ _id: { $in: ids } }).lean()
    return new Map(docs.map(doc => [doc._id.toString(), doc.name]))
  }

  async function requireGroup(groupName: string): Promise<Types.ObjectId> {
    const group = await models.policyGroup.findOne({ name: groupName }).lean()
    if (!group) throw new Error(`[kyroguard] Policy group "${groupName}" not found.`)
    return group._id
  }

  function castResourceIds(resource: ResourceDefinition, ids: string[]): unknown[] {
    const table = resource.table as
      | { schema?: { path?: (name: string) => { instance?: string } | undefined } }
      | undefined
    const instance = table?.schema?.path?.('_id')?.instance
    if (instance !== 'ObjectId' && instance !== 'ObjectID') return ids
    const { ObjectId } = connection.base.Types
    return ids.map(id => (ObjectId.isValid(id) ? new ObjectId(id) : id))
  }

  async function idListWhere(
    resource: ResourceDefinition,
    match: Record<string, unknown>,
  ): Promise<{ where: unknown }> {
    const ids: string[] = await models.resourceOwner.distinct('resourceId', match)
    return { where: { _id: { $in: castResourceIds(resource, ids) } } }
  }

  return {
    id: 'mongoose',
    capabilities: { autoOwnershipTracking: true, queryScoping: true, listFiltering: true },

    async ensureSchema(): Promise<void> {
      // S22 migration: pre-relation rows are 'owner' rows — backfill before
      // syncIndexes builds the unique index that includes `relation`.
      await models.resourceOwner.updateMany(
        { relation: { $exists: false } },
        { $set: { relation: 'owner' } },
      )
      await Promise.all(Object.values(models).map(model => model.syncIndexes()))
    },

    async upsertPolicies(rows: PolicyDefinitionRow[]): Promise<void> {
      if (rows.length === 0) return
      await models.policy.bulkWrite(
        rows.map(row => ({
          updateOne: {
            filter: { name: row.name },
            update: {
              $set: {
                domain: row.domain,
                label: row.label,
                scopeOptions: row.scopeOptions,
                dependsOn: row.dependsOn,
              },
            },
            upsert: true,
          },
        })),
      )
    },

    async listPolicies(): Promise<PolicyRecord[]> {
      const docs = await models.policy.find({}).lean()
      return docs.map(doc => ({
        id: doc._id.toString(),
        name: doc.name,
        domain: doc.domain ?? '',
        scopeOptions: doc.scopeOptions ?? [],
        dependsOn: doc.dependsOn ?? [],
      }))
    },

    async deletePolicies(ids: string[]): Promise<void> {
      if (ids.length === 0) return
      await models.policyGroupPolicy.deleteMany({ policyId: { $in: ids } })
      await models.userPolicy.deleteMany({ policyId: { $in: ids } })
      await models.policy.deleteMany({ _id: { $in: ids } })
    },

    async upsertGroup(group): Promise<void> {
      // S7: omitted optional fields keep their stored value; insert defaults
      // go through $setOnInsert (a field may appear in only one operator).
      const set: Record<string, unknown> = { label: group.label }
      const setOnInsert: Record<string, unknown> = {}
      if (group.description !== undefined) set['description'] = group.description
      else setOnInsert['description'] = ''
      if (group.isSystem !== undefined) set['isSystem'] = group.isSystem
      else setOnInsert['isSystem'] = false
      if (group.isActive !== undefined) set['isActive'] = group.isActive
      else setOnInsert['isActive'] = true
      await models.policyGroup.updateOne(
        { name: group.name },
        { $set: set, $setOnInsert: setOnInsert },
        { upsert: true },
      )
    },

    async listGroups(): Promise<GroupRecord[]> {
      const docs = await models.policyGroup.find({}).lean()
      return docs.map(doc => ({
        id: doc._id.toString(),
        name: doc.name,
        label: doc.label ?? '',
        isSystem: doc.isSystem ?? false,
        isActive: doc.isActive ?? true,
      }))
    },

    async getGroupPolicies(groupName: string): Promise<GroupPolicyEntry[]> {
      const group = await models.policyGroup.findOne({ name: groupName }).lean()
      if (!group) return []
      const entries = await models.policyGroupPolicy.find({ policyGroupId: group._id }).lean()
      const names = await policyNamesById(entries.map(entry => entry.policyId))
      const result: GroupPolicyEntry[] = []
      for (const entry of entries) {
        const policyName = names.get(entry.policyId.toString())
        if (policyName !== undefined) result.push({ policyName, scope: entry.scope ?? null })
      }
      return result
    },

    async setGroupPolicies(groupName: string, entries: GroupPolicyEntry[]): Promise<void> {
      const groupId = await requireGroup(groupName)
      const idsByName = await resolvePolicyIds(entries.map(entry => entry.policyName))
      const keepIds = [...idsByName.values()]
      await models.policyGroupPolicy.deleteMany({
        policyGroupId: groupId,
        policyId: { $nin: keepIds },
      })
      if (entries.length === 0) return
      await models.policyGroupPolicy.bulkWrite(
        entries.map(entry => ({
          updateOne: {
            filter: { policyGroupId: groupId, policyId: idsByName.get(entry.policyName)! },
            update: { $set: { scope: entry.scope ?? null } },
            upsert: true,
          },
        })),
      )
    },

    async addGroupPolicies(groupName: string, entries: GroupPolicyEntry[]): Promise<void> {
      if (entries.length === 0) return
      const groupId = await requireGroup(groupName)
      const idsByName = await resolvePolicyIds(entries.map(entry => entry.policyName))
      await models.policyGroupPolicy.bulkWrite(
        entries.map(entry => ({
          updateOne: {
            filter: { policyGroupId: groupId, policyId: idsByName.get(entry.policyName)! },
            update: { $setOnInsert: { scope: entry.scope ?? null } },
            upsert: true,
          },
        })),
      )
    },

    async assignGroup(ref: SubjectRef, groupName: string): Promise<void> {
      const groupId = await requireGroup(groupName)
      try {
        await models.userPolicyGroup.updateOne(
          {
            subjectId: ref.subjectId,
            policyGroupId: groupId,
            domain: ref.domain,
            tenantId: ref.tenantId,
          },
          { $setOnInsert: { subjectId: ref.subjectId } },
          { upsert: true },
        )
      } catch (error) {
        // S10 race: loser's duplicate-key error on the same tuple is equivalent to success.
        if (!isDuplicateKeyError(error)) throw error
      }
    },

    async removeGroup(ref: SubjectRef, groupName: string): Promise<void> {
      const group = await models.policyGroup.findOne({ name: groupName }).lean()
      if (!group) return
      await models.userPolicyGroup.deleteMany({
        subjectId: ref.subjectId,
        policyGroupId: group._id,
        domain: ref.domain,
        tenantId: ref.tenantId,
      })
    },

    async assignPolicy(ref: SubjectRef, policyName: string, scope?: string | null): Promise<void> {
      const idsByName = await resolvePolicyIds([policyName])
      const policyId = idsByName.get(policyName)!
      try {
        await models.userPolicy.updateOne(
          {
            subjectId: ref.subjectId,
            policyId,
            domain: ref.domain,
            tenantId: ref.tenantId,
          },
          { $set: { scope: scope ?? null } },
          { upsert: true },
        )
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error
      }
    },

    async removePolicy(ref: SubjectRef, policyName: string): Promise<void> {
      const policy = await models.policy.findOne({ name: policyName }).lean()
      if (!policy) return
      await models.userPolicy.deleteMany({
        subjectId: ref.subjectId,
        policyId: policy._id,
        domain: ref.domain,
        tenantId: ref.tenantId,
      })
    },

    async getSubjectPolicies(ref: SubjectRef): Promise<PolicyGrant[]> {
      const match = {
        subjectId: ref.subjectId,
        domain: ref.domain,
        tenantId: ref.tenantId,
      }

      const groupGrants: PolicyGrant[] = []
      const assignments = await models.userPolicyGroup.find(match).lean()
      if (assignments.length > 0) {
        // S20: deactivated groups grant nothing.
        const activeGroups = await models.policyGroup
          .find({ _id: { $in: assignments.map(a => a.policyGroupId) }, isActive: true }, { _id: 1 })
          .lean()
        const entries = await models.policyGroupPolicy
          .find({ policyGroupId: { $in: activeGroups.map(g => g._id) } })
          .lean()
        const names = await policyNamesById(entries.map(entry => entry.policyId))
        for (const entry of entries) {
          const name = names.get(entry.policyId.toString())
          if (name !== undefined) groupGrants.push({ name, scope: entry.scope ?? null })
        }
      }

      const directGrants: PolicyGrant[] = []
      const direct = await models.userPolicy.find(match).lean()
      if (direct.length > 0) {
        const names = await policyNamesById(direct.map(row => row.policyId))
        for (const row of direct) {
          const name = names.get(row.policyId.toString())
          if (name !== undefined) directGrants.push({ name, scope: row.scope ?? null })
        }
      }

      return [...groupGrants.sort(byName), ...directGrants.sort(byName)]
    },

    async recordOwnership(entries: OwnershipEntry[]): Promise<void> {
      if (entries.length === 0) return
      await models.resourceOwner.bulkWrite(
        entries.map(entry => ({
          updateOne: {
            filter: {
              resourceType: entry.resourceType,
              resourceId: entry.resourceId,
              ownerId: entry.ownerId,
              relation: entry.relation ?? 'owner',
            },
            update: { $set: { domain: entry.domain, tenantId: entry.tenantId } },
            upsert: true,
          },
        })),
      )
    },

    async isOwner(ownerId: string, resource: ResourceRef): Promise<boolean> {
      const found = await models.resourceOwner.exists({
        ownerId,
        resourceType: resource.type,
        resourceId: resource.id,
        relation: 'owner',
      })
      return found !== null
    },

    async removeOwnership(resource: ResourceRef): Promise<void> {
      await models.resourceOwner.deleteMany({
        resourceType: resource.type,
        resourceId: resource.id,
      })
    },

    async getAccess(resource: ResourceRef): Promise<OwnershipEntry[]> {
      const docs = await models.resourceOwner
        .find({ resourceType: resource.type, resourceId: resource.id })
        .lean()
      return docs.map(doc => ({
        resourceType: doc.resourceType,
        resourceId: doc.resourceId,
        ownerId: doc.ownerId,
        relation: doc.relation ?? 'owner',
        domain: doc.domain ?? '',
        tenantId: doc.tenantId ?? '',
      }))
    },

    async removeAccess(ownerId: string, resource: ResourceRef, relation?: string): Promise<void> {
      const filter: Record<string, unknown> = {
        ownerId,
        resourceType: resource.type,
        resourceId: resource.id,
      }
      if (relation !== undefined) filter['relation'] = relation
      await models.resourceOwner.deleteMany(filter)
    },

    listFilters: {
      owned(subjectId, resource) {
        return idListWhere(resource, {
          resourceType: resource.type,
          ownerId: subjectId,
          relation: 'owner',
        })
      },
      inTenant(tenantId, resource) {
        // '' sentinel means "no tenant" — it must never match sentinel rows.
        if (tenantId === '') return { where: { _id: { $in: [] } } }
        return idListWhere(resource, { resourceType: resource.type, tenantId })
      },
      granted(subjectId, resource) {
        return idListWhere(resource, {
          resourceType: resource.type,
          ownerId: subjectId,
          relation: 'granted',
        })
      },
      or(fragments) {
        return { $or: fragments }
      },
      none() {
        return { _id: { $in: [] } }
      },
    },
  }
}
