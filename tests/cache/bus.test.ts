/// <reference types="bun-types" />
import { describe, test, expect } from 'bun:test'
import { inProcessBus } from '../../src/cache/bus.js'
import type { InvalidationEvent } from '../../src/cache/types.js'

describe('inProcessBus', () => {
  test('delivers events to all subscribers', async () => {
    const bus = inProcessBus()
    const seenA: InvalidationEvent[] = []
    const seenB: InvalidationEvent[] = []
    bus.subscribe((e) => seenA.push(e))
    bus.subscribe((e) => seenB.push(e))

    await bus.publish({ type: 'subject', subjectId: 'u1' })
    await bus.publish({ type: 'all' })

    expect(seenA).toEqual([{ type: 'subject', subjectId: 'u1' }, { type: 'all' }])
    expect(seenB).toEqual([{ type: 'subject', subjectId: 'u1' }, { type: 'all' }])
  })

  test('unsubscribe stops delivery to that handler only', async () => {
    const bus = inProcessBus()
    const seenA: InvalidationEvent[] = []
    const seenB: InvalidationEvent[] = []
    const unsubA = bus.subscribe((e) => seenA.push(e))
    bus.subscribe((e) => seenB.push(e))

    await bus.publish({ type: 'all' })
    unsubA()
    await bus.publish({ type: 'subject', subjectId: 'u2' })

    expect(seenA).toEqual([{ type: 'all' }])
    expect(seenB).toEqual([{ type: 'all' }, { type: 'subject', subjectId: 'u2' }])
  })

  test('a throwing handler does not block delivery to the others', async () => {
    const bus = inProcessBus()
    const seen: InvalidationEvent[] = []
    bus.subscribe(() => {
      throw new Error('boom')
    })
    bus.subscribe((e) => seen.push(e))
    bus.subscribe(() => {
      throw new Error('boom again')
    })

    await bus.publish({ type: 'subject', subjectId: 'u1' })
    expect(seen).toEqual([{ type: 'subject', subjectId: 'u1' }])
  })

  test('close() clears handlers — no delivery afterwards', async () => {
    const bus = inProcessBus()
    const seen: InvalidationEvent[] = []
    bus.subscribe((e) => seen.push(e))

    await bus.close?.()
    await bus.publish({ type: 'all' })
    expect(seen).toEqual([])
  })

  test('calling an unsubscribe function twice is harmless', async () => {
    const bus = inProcessBus()
    const seen: InvalidationEvent[] = []
    const unsub = bus.subscribe((e) => seen.push(e))
    unsub()
    unsub()
    await bus.publish({ type: 'all' })
    expect(seen).toEqual([])
  })
})