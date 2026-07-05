import { normalizeSentinel } from '../../core/types.js'
import type { FilterQuery, Query, Schema } from 'mongoose'
import type { RbacEngine } from '../../core/engine.js'
import type { Subject } from '../../core/types.js'
import type { OwnershipEntry, StorageAdapter } from '../contract.js'

export interface RbacMongoosePluginOptions {
  rbac: { engine: RbacEngine; adapter: StorageAdapter }
  /** The resource type recorded in the ownership store, e.g. 'post'. */
  type: string
  /** Named query-scope builders: scope name → subject → Mongo filter. */
  queryScopes?: Record<string, (subject: Subject) => Record<string, unknown>>
  /** portal → policy name → scope names (mirrors ResourceDefinition.context). */
  context?: Record<string, Record<string, string[]>>
}

function documentId(doc: unknown): string | null {
  if (typeof doc !== 'object' || doc === null) return null
  const id = (doc as { _id?: string | { toString(): string } })._id
  if (id === null || id === undefined) return null
  return typeof id === 'string' ? id : id.toString()
}

/**
 * Mongoose schema plugin: automatic ownership tracking + query scoping.
 *
 * - `post('save')` / `post('insertMany')` record ownership for the current
 *   request subject (no-op when no subject is set).
 * - `post('deleteOne')` (document) / `post('findOneAndDelete')` remove all
 *   ownership rows for the deleted document.
 * - `pre(/^find/)` merges the subject's portal query scopes ($or-combined)
 *   into the query filter.
 *
 * LIMITATION: `Model.updateMany`, `Model.deleteMany`, `Model.bulkWrite` and
 * raw collection operations fire NO document middleware, so ownership is not
 * tracked or cleaned up for those paths — call `rbac.ownership.record()` /
 * `rbac.ownership.remove()` explicitly there.
 */
export function rbacMongoosePlugin(schema: Schema, options: RbacMongoosePluginOptions): void {
  const { engine, adapter } = options.rbac

  async function recordOwnershipFor(docs: unknown[]): Promise<void> {
    const subject = engine.store.getSubject()
    if (!subject) return
    const contextType = normalizeSentinel(subject.portal)
    const contextId = normalizeSentinel(subject.context_id)
    const entries: OwnershipEntry[] = []
    for (const doc of docs) {
      const resourceId = documentId(doc)
      if (resourceId === null) continue
      entries.push({
        resourceType: options.type,
        resourceId,
        ownerId: subject.id,
        contextType,
        contextId,
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

  schema.pre(/^find/, function (this: Query<unknown, unknown>, next) {
    const subject = engine.store.getSubject()
    if (!subject) return next()

    const portalContext = options.context?.[normalizeSentinel(subject.portal)]
    if (!portalContext) return next()

    const filters: Record<string, unknown>[] = []
    const seen = new Set<string>()
    for (const scopeNames of Object.values(portalContext)) {
      for (const scopeName of scopeNames) {
        if (seen.has(scopeName)) continue
        seen.add(scopeName)
        const build = options.queryScopes?.[scopeName]
        if (build) filters.push(build(subject))
      }
    }
    if (filters.length === 0) return next()

    const scopeFilter = filters.length === 1 ? filters[0]! : { $or: filters }
    const current = this.getFilter()
    const merged =
      Object.keys(current).length === 0 ? scopeFilter : { $and: [current, scopeFilter] }
    this.setQuery(merged as FilterQuery<unknown>)
    next()
  })
}
