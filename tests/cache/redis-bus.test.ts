/// <reference types="bun-types" />
import { describe, test, expect } from 'bun:test'
import { redisBus } from '../../src/cache/redis.js'
import type { RedisPublisherLike, RedisSubscriberLike } from '../../src/cache/redis.js'
import type { InvalidationEvent } from '../../src/cache/types.js'

type MessageListener = (channel: string, message: string) => void

/**
 * In-test pub/sub hub emulating a redis server: publishers push into the hub,
 * subscriber clients receive on channels they SUBSCRIBEd to.
 */
function fakeHub() {
  const clients: FakeSubscriber[] = []

  class FakeSubscriber implements RedisSubscriberLike {
    channels = new Set<string>()
    listeners = new Set<MessageListener>()
    subscribeCalls: string[] = []
    unsubscribeCalls: string[] = []

    constructor() {
      clients.push(this)
    }

    subscribe(channel: string): Promise<unknown> {
      this.subscribeCalls.push(channel)
      this.channels.add(channel)
      return Promise.resolve(1)
    }

    unsubscribe(channel: string): Promise<unknown> {
      this.unsubscribeCalls.push(channel)
      this.channels.delete(channel)
      return Promise.resolve(0)
    }

    on(event: 'message', listener: MessageListener): unknown {
      if (event === 'message') this.listeners.add(listener)
      return this
    }

    off(event: 'message', listener: MessageListener): unknown {
      if (event === 'message') this.listeners.delete(listener)
      return this
    }

    deliver(channel: string, message: string): void {
      if (!this.channels.has(channel)) return
      for (const listener of [...this.listeners]) listener(channel, message)
    }
  }

  class FakePublisher implements RedisPublisherLike {
    published: Array<{ channel: string; message: string }> = []

    publish(channel: string, message: string): Promise<unknown> {
      this.published.push({ channel, message })
      for (const client of clients) client.deliver(channel, message)
      return Promise.resolve(clients.length)
    }
  }

  return {
    publisher: () => new FakePublisher(),
    subscriber: () => new FakeSubscriber(),
    /** Raw server-side push, bypassing any bus (a "foreign" publisher). */
    raw(channel: string, message: string): void {
      for (const client of clients) client.deliver(channel, message)
    },
  }
}

describe('redisBus', () => {
  test('publish serializes the event as JSON to the configured channel', async () => {
    const hub = fakeHub()
    const publisher = hub.publisher()
    const bus = redisBus(publisher, hub.subscriber(), { channel: 'my-chan' })

    await bus.publish({ type: 'subject', subjectId: 'u1' })
    await bus.publish({ type: 'all' })

    expect(publisher.published).toHaveLength(2)
    expect(publisher.published[0]!.channel).toBe('my-chan')
    expect(JSON.parse(publisher.published[0]!.message)).toEqual({ type: 'subject', subjectId: 'u1' })
    expect(publisher.published[1]!.channel).toBe('my-chan')
    expect(JSON.parse(publisher.published[1]!.message)).toEqual({ type: 'all' })
  })

  test('publish uses the default channel when none is configured', async () => {
    const hub = fakeHub()
    const publisher = hub.publisher()
    const bus = redisBus(publisher, hub.subscriber())
    await bus.publish({ type: 'all' })
    expect(publisher.published[0]!.channel).toBe('rbac:invalidate')
  })

  test("a subscribed bus receives events published by 'another instance' through the hub", async () => {
    const hub = fakeHub()
    const busA = redisBus(hub.publisher(), hub.subscriber())
    const busB = redisBus(hub.publisher(), hub.subscriber())

    const seen: InvalidationEvent[] = []
    busB.subscribe((e) => seen.push(e))

    // Let busB's lazy SUBSCRIBE promise settle before instance A publishes.
    await Promise.resolve()
    await busA.publish({ type: 'subject', subjectId: 'u1' })
    await busA.publish({ type: 'all' })

    expect(seen).toEqual([{ type: 'subject', subjectId: 'u1' }, { type: 'all' }])
  })

  test('malformed JSON and unknown event shapes are ignored', async () => {
    const hub = fakeHub()
    const bus = redisBus(hub.publisher(), hub.subscriber())
    const seen: InvalidationEvent[] = []
    bus.subscribe((e) => seen.push(e))
    await Promise.resolve()

    const channel = 'rbac:invalidate'
    hub.raw(channel, 'not json at all')
    hub.raw(channel, '{"type":') // truncated JSON
    hub.raw(channel, 'null')
    hub.raw(channel, '42')
    hub.raw(channel, '"subject"')
    hub.raw(channel, '["subject","u1"]') // array, wrong shape (typeof object but no valid type)
    hub.raw(channel, '{"type":"unknown"}')
    hub.raw(channel, '{"type":"subject"}') // missing subjectId
    hub.raw(channel, '{"type":"subject","subjectId":42}') // non-string subjectId
    hub.raw(channel, '{"subjectId":"u1"}') // missing type

    expect(seen).toEqual([])

    // The bus still works after garbage.
    hub.raw(channel, '{"type":"subject","subjectId":"u1"}')
    expect(seen).toEqual([{ type: 'subject', subjectId: 'u1' }])
  })

  test('messages on a different channel are ignored', async () => {
    const hub = fakeHub()
    const subscriber = hub.subscriber()
    const bus = redisBus(hub.publisher(), subscriber, { channel: 'chan-a' })
    const seen: InvalidationEvent[] = []
    bus.subscribe((e) => seen.push(e))
    await Promise.resolve()

    // Simulate the client being subscribed to another channel too, so the
    // hub delivers — the bus itself must filter by channel name.
    subscriber.channels.add('chan-b')
    hub.raw('chan-b', '{"type":"all"}')
    expect(seen).toEqual([])

    hub.raw('chan-a', '{"type":"all"}')
    expect(seen).toEqual([{ type: 'all' }])
  })

  test('lazy subscribe: SUBSCRIBE is only issued on the first bus.subscribe', async () => {
    const hub = fakeHub()
    const subscriber = hub.subscriber()
    const bus = redisBus(hub.publisher(), subscriber)

    // Creating the bus and publishing cause no SUBSCRIBE traffic.
    await bus.publish({ type: 'all' })
    expect(subscriber.subscribeCalls).toEqual([])
    expect(subscriber.listeners.size).toBe(0)

    bus.subscribe(() => {})
    expect(subscriber.subscribeCalls).toEqual(['rbac:invalidate'])
    expect(subscriber.listeners.size).toBe(1)

    // Subsequent subscribes reuse the existing wiring.
    bus.subscribe(() => {})
    bus.subscribe(() => {})
    expect(subscriber.subscribeCalls).toEqual(['rbac:invalidate'])
    expect(subscriber.listeners.size).toBe(1)
  })

  test('unsubscribe stops delivery to that handler only', async () => {
    const hub = fakeHub()
    const bus = redisBus(hub.publisher(), hub.subscriber())
    const seenA: InvalidationEvent[] = []
    const seenB: InvalidationEvent[] = []
    const unsubA = bus.subscribe((e) => seenA.push(e))
    bus.subscribe((e) => seenB.push(e))
    await Promise.resolve()

    hub.raw('rbac:invalidate', '{"type":"all"}')
    unsubA()
    hub.raw('rbac:invalidate', '{"type":"subject","subjectId":"u1"}')

    expect(seenA).toEqual([{ type: 'all' }])
    expect(seenB).toEqual([{ type: 'all' }, { type: 'subject', subjectId: 'u1' }])
  })

  test('a throwing handler does not block delivery to the others', async () => {
    const hub = fakeHub()
    const bus = redisBus(hub.publisher(), hub.subscriber())
    const seen: InvalidationEvent[] = []
    bus.subscribe(() => {
      throw new Error('boom')
    })
    bus.subscribe((e) => seen.push(e))
    await Promise.resolve()

    hub.raw('rbac:invalidate', '{"type":"all"}')
    expect(seen).toEqual([{ type: 'all' }])
  })

  test('close() unsubscribes from the channel and detaches the message listener', async () => {
    const hub = fakeHub()
    const subscriber = hub.subscriber()
    const bus = redisBus(hub.publisher(), subscriber)
    const seen: InvalidationEvent[] = []
    bus.subscribe((e) => seen.push(e))
    await Promise.resolve()

    await bus.close?.()

    expect(subscriber.unsubscribeCalls).toEqual(['rbac:invalidate'])
    expect(subscriber.listeners.size).toBe(0)

    // Even if the server still pushed a message, nothing is delivered.
    subscriber.channels.add('rbac:invalidate')
    hub.raw('rbac:invalidate', '{"type":"all"}')
    expect(seen).toEqual([])
  })

  test('close() before any subscribe issues no redis traffic', async () => {
    const hub = fakeHub()
    const subscriber = hub.subscriber()
    const bus = redisBus(hub.publisher(), subscriber)
    await bus.close?.()
    expect(subscriber.unsubscribeCalls).toEqual([])
    expect(subscriber.subscribeCalls).toEqual([])
  })

  test('works with a subscriber lacking optional unsubscribe/off', async () => {
    const hub = fakeHub()
    const listeners = new Set<MessageListener>()
    const minimal: RedisSubscriberLike = {
      subscribe: () => Promise.resolve(1),
      on: (event, listener) => {
        if (event === 'message') listeners.add(listener)
        return undefined
      },
    }
    const bus = redisBus(hub.publisher(), minimal)
    const seen: InvalidationEvent[] = []
    bus.subscribe((e) => seen.push(e))
    await Promise.resolve()

    for (const listener of listeners) listener('rbac:invalidate', '{"type":"all"}')
    expect(seen).toEqual([{ type: 'all' }])

    // close() must not throw when optional methods are absent.
    await bus.close?.()
  })
})