import { MisconfiguredError, RbacError } from '../index.js'
import type { FilterResult, QualifiedPolicyName, Rbac, Subject } from '../index.js'

export interface AssertScopeParityOptions {
  rbac: Rbac
  subject: Subject
  policy: QualifiedPolicyName
  /** The registered resource type being listed. */
  resource: string
  /** All seeded rows as { id } plus whatever the query returns. */
  rows: Array<{ id: string }>
  /** Runs the caller's list query with the given FilterResult applied. */
  query: (filter: FilterResult) => Promise<Array<{ id: string }>>
}

/**
 * The invariant of RFC §2.7: for every seeded row,
 * authorize(subject, policy, row) resolves ⇔ the row appears in the
 * filterFor-filtered query. Rejects with one Error naming every violation.
 */
export async function assertScopeParity(options: AssertScopeParityOptions): Promise<void> {
  const { rbac, subject, policy, resource, rows, query } = options

  const definition = rbac.resources.find(candidate => candidate.type === resource)
  if (!definition) {
    throw new MisconfiguredError(
      `[rbac] assertScopeParity: resource type "${resource}" is not registered on this rbac instance.`,
    )
  }

  const filter = await rbac.engine.filterFor(subject, policy, definition)
  const listed = new Set((await query(filter)).map(row => row.id))

  const violations: string[] = []
  for (const row of rows) {
    let allowed = true
    try {
      await rbac.engine.authorize(subject, policy, {
        resource: () => ({ type: resource, id: row.id }),
      })
    } catch (error) {
      if (!(error instanceof RbacError)) throw error
      allowed = false
    }
    const inList = listed.has(row.id)
    if (allowed && !inList) {
      violations.push(`row "${row.id}": check allows but the filtered list omits it`)
    } else if (!allowed && inList) {
      violations.push(`row "${row.id}": check denies but the filtered list contains it`)
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `[rbac] Scope parity violated for policy "${policy}" on resource "${resource}" ` +
        `(filter kind: ${filter.kind}):\n  - ${violations.join('\n  - ')}`,
    )
  }
}
