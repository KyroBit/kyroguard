/**
 * Executable specification of what every ORM integration owes — scopedDb
 * (Drizzle), the Prisma extension, the Mongoose plugin, and whatever comes next.
 *
 * The storage suite proves an adapter can persist grants. This one proves the
 * integration on top of it applies them: that a grant which narrows what a
 * subject may read narrows what it may write by exactly the same amount.
 *
 * That symmetry is the whole point. Filtering reads but not writes leaves a
 * subject able to destroy rows it cannot see, which is worse than not filtering
 * at all — the reads look safe. Each integration is free to implement it however
 * its ORM allows; it is not free to skip a clause.
 *
 * Clause ids (Q1–Q7) appear in every case name so a failure names the promise
 * that broke.
 */

import type { SuiteTestApi } from './adapter-suite.js'

export interface IntegrationRows {
  /** Ids currently visible to the subject through the integration's read path. */
  read: () => Promise<string[]>
  /** Ids present in the table, read outside the integration entirely. */
  all: () => Promise<string[]>
}

export interface IntegrationHarness {
  /** Runs `fn` with a guard-activated filter narrowing the resource to `allowed`. */
  guarded: <T>(allowed: string[], fn: () => Promise<T>) => Promise<T>
  /** Runs `fn` with a subject but no activated filter — the unguarded path. */
  unguarded: <T>(fn: () => Promise<T>) => Promise<T>
  rows: IntegrationRows
  /** Marks every row through the integration's write path, without naming ids. */
  markAll: (mark: string) => Promise<void>
  /** Ids currently carrying `mark`, read outside the integration. */
  marked: (mark: string) => Promise<string[]>
  /** Deletes every row through the integration's write path, without naming ids. */
  deleteAll: () => Promise<void>
}

export interface IntegrationSuiteOptions {
  name: string
  /** Fresh fixture with three rows: 'r1', 'r2', 'r3'. */
  makeHarness: () => Promise<{ harness: IntegrationHarness; cleanup?: () => Promise<void> }>
  test: SuiteTestApi
  /**
   * Clauses this integration cannot satisfy, with the reason. A skipped clause is
   * still reported, so a gap is a visible decision rather than a silent absence.
   */
  unsupported?: Partial<Record<'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | 'Q6' | 'Q7', string>>
}

export function runQueryIntegrationContractSuite(options: IntegrationSuiteOptions): void {
  const { describe, it, expect } = options.test
  const skipped = options.unsupported ?? {}

  const withHarness = async (fn: (harness: IntegrationHarness) => Promise<void>): Promise<void> => {
    const { harness, cleanup } = await options.makeHarness()
    try {
      await fn(harness)
    } finally {
      if (cleanup) await cleanup()
    }
  }

  /** A clause the integration declared unsupported still runs — as its reason. */
  const clause = (
    id: keyof typeof skipped,
    name: string,
    fn: (harness: IntegrationHarness) => Promise<void>,
  ): void => {
    const reason = skipped[id]
    if (reason) {
      it(`${id}: UNSUPPORTED — ${reason}`, () => {
        expect(reason).toBeTruthy()
      })
      return
    }
    it(`${id}: ${name}`, () => withHarness(fn))
  }

  describe(`query integration contract — ${options.name}`, () => {
    clause('Q1', 'reads return only the rows the filter allows', async harness => {
      const seen = await harness.guarded(['r1', 'r2'], () => harness.rows.read())
      expect([...seen].sort()).toEqual(['r1', 'r2'])
    })

    clause('Q2', 'an unfiltered write reaches only the rows the filter allows', async harness => {
      await harness.guarded(['r1'], () => harness.markAll('touched'))

      expect(await harness.marked('touched')).toEqual(['r1'])
    })

    clause('Q3', 'an unfiltered delete removes only the rows the filter allows', async harness => {
      await harness.guarded(['r1', 'r2'], () => harness.deleteAll())

      expect(await harness.rows.all()).toEqual(['r3'])
    })

    clause('Q4', 'a filter allowing nothing writes nothing rather than everything', async harness => {
      await harness.guarded([], () => harness.markAll('touched'))

      expect(await harness.marked('touched')).toEqual([])
    })

    clause('Q5', 'a filter allowing nothing deletes nothing rather than everything', async harness => {
      await harness.guarded([], () => harness.deleteAll())

      expect(await harness.rows.all()).toEqual(['r1', 'r2', 'r3'])
    })

    clause('Q6', 'writes and reads are narrowed by the same amount', async harness => {
      const seen = await harness.guarded(['r2'], () => harness.rows.read())
      await harness.guarded(['r2'], () => harness.markAll('touched'))

      // The clause that makes the suite worth having: whatever an integration
      // filters on the read path, it filters identically on the write path.
      expect(await harness.marked('touched')).toEqual([...seen].sort())
    })

    clause('Q7', 'without an activated filter reads and writes are untouched', async harness => {
      const seen = await harness.unguarded(() => harness.rows.read())
      expect([...seen].sort()).toEqual(['r1', 'r2', 'r3'])

      await harness.unguarded(() => harness.markAll('touched'))
      expect(await harness.marked('touched')).toEqual(['r1', 'r2', 'r3'])
    })
  })
}
