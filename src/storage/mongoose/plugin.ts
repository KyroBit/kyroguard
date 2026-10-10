import type { FilterQuery, Query, Schema } from 'mongoose'
import { MisconfiguredError } from '../../core/errors.js'
import type { GuardEngine } from '../../core/engine.js'

/** The subset of a Mongoose document the stamp needs; structural by design. */
interface StampableDocument {
  isNew?: boolean
  get(path: string): unknown
  set(path: string, value: unknown): void
}

export interface ScopePluginOptions {
  guard: { engine: GuardEngine }
  /** The resource type whose activated filter narrows this schema, e.g. 'post'. */
  type: string
}

/**
 * Mongoose schema plugin: narrows every query it can hook to the rows the
 * request's active filter allows (the store's activeFilters plan), and stamps
 * new documents with the grant's insert columns so a document created under a
 * grant is one the same grant can read back. bulkWrite and raw collection ops
 * fire no middleware and are therefore untouched — see
 * docs/reference/mongoose.md.
 */
export function scopePlugin(schema: Schema, options: ScopePluginOptions): void {
  const { engine } = options.guard

  // Narrows any query — read or write — to the rows the active grant allows. A
  // subject that may only read its own rows must not be able to update or delete
  // the others: filtering reads alone leaves writes reaching every document.
  const applyFilter = async function (this: Query<unknown, unknown>): Promise<void> {
    // Scope filters must see the unfiltered collection — the engine marks
    // those queries via isInAuthz.
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
  schema.pre(/^find/, applyFilter)
  schema.pre('countDocuments', applyFilter)
  // findOneAndUpdate / findOneAndDelete already match /^find/.
  schema.pre(/^update/, applyFilter)
  schema.pre(/^delete/, applyFilter)
  schema.pre('replaceOne', applyFilter)

  // The grant's insert columns are the same fact its filter reads by, so a
  // document saved with a different value would be invisible to its author.
  const applyStamp = function (this: StampableDocument): void {
    if (engine.store.isInAuthz()) return
    const stamp = engine.store.getActiveInsert(options.type)
    if (!stamp) return
    for (const [path, value] of Object.entries(stamp)) {
      const current = this.get(path)
      if (current !== undefined && current !== null && current !== value) {
        throw new MisconfiguredError(
          `[kyroguard] save on "${options.type}": the grant sets "${path}" to ` +
            `${JSON.stringify(value)}, but this document carries ${JSON.stringify(current)} — ` +
            `it would be unreadable to whoever created it.`,
        )
      }
      this.set(path, value)
    }
  }
  schema.pre('save', function (this: unknown) {
    const doc = this as StampableDocument
    if (!doc.isNew) return
    applyStamp.call(doc)
  })
  schema.pre('insertMany', function (_next: unknown, docs: Record<string, unknown>[]) {
    const stamp = engine.store.getActiveInsert(options.type)
    if (!stamp || engine.store.isInAuthz()) return
    for (const doc of docs) {
      for (const [path, value] of Object.entries(stamp)) {
        if (doc[path] !== undefined && doc[path] !== value) {
          throw new MisconfiguredError(
            `[kyroguard] insertMany on "${options.type}": the grant sets "${path}" to ` +
              `${JSON.stringify(value)}, but a document carries ${JSON.stringify(doc[path])}.`,
          )
        }
        doc[path] = value
      }
    }
  })
}
