import { normalizeSentinel } from '../../core/types.js'
import type { FilterQuery, Query, Schema } from 'mongoose'
import type { RbacEngine } from '../../core/engine.js'
import type { OwnershipEntry, StorageAdapter } from '../contract.js'

export interface RbacMongoosePluginOptions {
  rbac: { engine: RbacEngine; adapter: StorageAdapter }
  /** The resource type recorded in the ownership store, e.g. 'post'. */
  type: string
}

function documentId(doc: unknown): string | null {
  if (typeof doc !== 'object' || doc === null) return null
  const id = (doc as { _id?: string | { toString(): string } })._id
  if (id === null || id === undefined) return null
  return typeof id === 'string' ? id : id.toString()
}

/**
 * Mongoose schema plugin: automatic ownership tracking + read filtering
 * (pre find/countDocuments) driven by the request's guard-activated filter
 * (the store's activeFilters plan). updateMany/deleteMany/bulkWrite and raw
 * collection ops fire NO document middleware, so they are neither tracked
 * nor filtered — see docs/reference/mongoose.md.
 */
export function rbacMongoosePlugin(schema: Schema, options: RbacMongoosePluginOptions): void {
  const { engine, adapter } = options.rbac

  async function recordOwnershipFor(docs: unknown[]): Promise<void> {
    const subject = engine.store.getSubject()
    if (!subject) return
    const domain = normalizeSentinel(subject.domain)
    const tenantId = normalizeSentinel(subject.tenant_id)
    const entries: OwnershipEntry[] = []
    for (const doc of docs) {
      const resourceId = documentId(doc)
      if (resourceId === null) continue
      entries.push({
        resourceType: options.type,
        resourceId,
        ownerId: subject.id,
        domain,
        tenantId,
      })
    }
    if (entries.length > 0) await adapter.recordOwnership(entries)
  }

  async function removeOwnershipFor(doc: unknown): Promise<void> {
    const resourceId = documentId(doc)
    if (resourceId === null) return
    await adapter.removeOwnership({ type: options.type, id: resourceId })
  }

  schema.post('save', async function (doc: unknown) {
    await recordOwnershipFor([doc])
  })

  schema.post('insertMany', async function (docs: unknown) {
    await recordOwnershipFor(Array.isArray(docs) ? docs : [docs])
  })

  schema.post('deleteOne', { document: true, query: false }, async function () {
    await removeOwnershipFor(this)
  })

  schema.post('findOneAndDelete', async function (doc: unknown) {
    if (doc) await removeOwnershipFor(doc)
  })

  const applyReadFilter = async function (this: Query<unknown, unknown>): Promise<void> {
    // Scope checks/filters and resource resolvers must see the unfiltered
    // collection — the engine marks those queries via isInAuthz.
    if (engine.store.isInAuthz()) return
    const plan = engine.store.getActiveFilter(options.type)
    if (!plan || plan.kind === 'all') return
    if (plan.kind === 'none') {
      this.where({ _id: { $in: [] } })
      return
    }
    const where = plan.where as FilterQuery<unknown>
    const current = this.getFilter()
    this.setQuery(
      Object.keys(current).length === 0
        ? where
        : ({ $and: [current, where] } as FilterQuery<unknown>),
    )
  }
  schema.pre(/^find/, applyReadFilter)
  schema.pre('countDocuments', applyReadFilter)
}
