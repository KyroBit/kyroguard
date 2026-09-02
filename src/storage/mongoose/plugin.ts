import type { FilterQuery, Query, Schema } from 'mongoose'
import type { GuardEngine } from '../../core/engine.js'

export interface ScopePluginOptions {
  guard: { engine: GuardEngine }
  /** The resource type whose activated filter narrows this schema, e.g. 'post'. */
  type: string
}

/**
 * Mongoose schema plugin: narrows every query it can hook to the rows the
 * request's active filter allows (the store's activeFilters plan). bulkWrite
 * and raw collection ops fire no middleware and are therefore unfiltered —
 * see docs/reference/mongoose.md.
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
}
