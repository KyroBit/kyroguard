import { describe, test, expect } from 'bun:test'
import { GuardEngine } from '../../src/core/engine.js'
import { SubjectStore } from '../../src/core/subject-store.js'
import { inProcessBus } from '../../src/cache/bus.js'
import { memoryAdapter } from '../../src/testing/index.js'
import type { Subject } from '../../src/core/types.js'

const tick = (ms = 1) => new Promise<void>(resolve => setTimeout(resolve, ms))

function makeEngine(): GuardEngine {
  return new GuardEngine({
    adapter: memoryAdapter(),
    scopes: new Map(),
    cache: null,
    bus: inProcessBus(),
  })
}

describe('SubjectStore.enter (callback form — the Bun ALS regression)', () => {
  test('context set inside done() is readable in async continuations scheduled from it', async () => {
    const store = new SubjectStore()
    const seen: Record<string, string | null> = {}

    await new Promise<void>(resolve => {
      store.enter(() => {
        store.setSubject({ id: 'u1' })
        seen.inCallback = store.getSubject()?.id ?? null

        // The continuation chain a framework hook actually runs: microtask,
        // macrotask, and code resuming after an await — all must still see
        // the store created by enter().
        void (async () => {
          await Promise.resolve()
          seen.inMicrotask = store.getSubject()?.id ?? null
          await tick(1)
          seen.afterAwait = store.getSubject()?.id ?? null
          setTimeout(() => {
            seen.inTimer = store.getSubject()?.id ?? null
            resolve()
          }, 1)
        })()
      })
    })

    expect(seen).toEqual({
      inCallback: 'u1',
      inMicrotask: 'u1',
      afterAwait: 'u1',
      inTimer: 'u1',
    })
    // And it never leaked outside the enter() chain.
    expect(store.getSubject()).toBeNull()
    expect(store.get()).toBeUndefined()
  })

  test('mutations made in a later continuation are visible to an even later one', async () => {
    const store = new SubjectStore()
    const seen: Record<string, string | null> = {}

    await new Promise<void>(resolve => {
      store.enter(() => {
        // Subject is resolved LATER (as a guard would), not inside done itself.
        setTimeout(() => {
          store.setSubject({ id: 'late' })
          setTimeout(() => {
            seen.late = store.getSubject()?.id ?? null
            resolve()
          }, 1)
        }, 1)
      })
    })

    expect(seen).toEqual({ late: 'late' })
  })
})

describe('SubjectStore.run isolation', () => {
  test('two concurrent run() contexts never see each other’s subject', async () => {
    const store = new SubjectStore()

    const results = await Promise.all([
      store.run(async () => {
        store.setSubject({ id: 'a' })
        await tick(5)
        return store.getSubject()?.id
      }),
      store.run(async () => {
        await tick(1)
        store.setSubject({ id: 'b' })
        await tick(10)
        return store.getSubject()?.id
      }),
    ])

    expect(results).toEqual(['a', 'b'])
    expect(store.getSubject()).toBeNull()
  })
})

describe('engine-scoped stores', () => {
  test('two engines have independent stores', () => {
    const engine1 = makeEngine()
    const engine2 = makeEngine()

    engine1.runWithRequestContext(() => {
      engine1.setRequestSubject({ id: 'u1' })
      expect(engine1.store.getSubject()).toEqual({ id: 'u1' } as Subject)
      // Engine 2 has no active context inside engine 1's run.
      expect(engine2.store.getSubject()).toBeNull()
      expect(engine2.store.get()).toBeUndefined()

      // Even setting through engine 2 must not leak into engine 1's store.
      engine2.setRequestSubject({ id: 'intruder' })
      expect(engine1.store.getSubject()).toEqual({ id: 'u1' } as Subject)
      expect(engine2.store.getSubject()).toBeNull()
    })
  })
})

describe('no-store behavior', () => {
  test('setSubject outside any context is a silent no-op', () => {
    const store = new SubjectStore()
    expect(() => store.setSubject({ id: 'ghost' })).not.toThrow()
    expect(store.getSubject()).toBeNull()
    expect(store.get()).toBeUndefined()
  })
})
