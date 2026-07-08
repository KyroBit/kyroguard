import type { Awaitable } from '../core/types.js'
import type { InvalidationBus, InvalidationEvent } from './types.js'

/**
 * Structural slices of an ioredis-compatible client pair — Redis requires
 * separate connections for publishing and subscribing.
 */
export interface RedisPublisherLike {
  publish(channel: string, message: string): Awaitable<unknown>
}

export interface RedisSubscriberLike {
  subscribe(channel: string): Awaitable<unknown>
  on(event: 'message', listener: (channel: string, message: string) => void): unknown
  unsubscribe?(channel: string): Awaitable<unknown>
  off?(event: 'message', listener: (channel: string, message: string) => void): unknown
}

export interface RedisBusOptions {
  channel?: string
}

const DEFAULT_CHANNEL = 'kyroguard:invalidate'

function parseEvent(message: string): InvalidationEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as { type?: unknown; subjectId?: unknown }
  if (candidate.type === 'all') return { type: 'all' }
  if (candidate.type === 'subject' && typeof candidate.subjectId === 'string') {
    return { type: 'subject', subjectId: candidate.subjectId }
  }
  return null
}

/** Cross-instance invalidation over redis pub/sub. */
export function redisBus(
  publisher: RedisPublisherLike,
  subscriber: RedisSubscriberLike,
  options?: RedisBusOptions,
): InvalidationBus {
  const channel = options?.channel ?? DEFAULT_CHANNEL
  const handlers = new Set<(event: InvalidationEvent) => void>()
  let listenerAttached = false
  let channelSubscribed = false

  const onMessage = (incomingChannel: string, message: string): void => {
    if (incomingChannel !== channel) return
    const event = parseEvent(message)
    if (event === null) return
    for (const handler of [...handlers]) {
      try {
        handler(event)
      } catch {
        // One failing handler must not block delivery to the rest.
      }
    }
  }

  // The bus contract's subscribe() is synchronous, so a failed SUBSCRIBE
  // cannot propagate — it resets the flag and the next subscribe() retries.
  const wire = (): void => {
    if (!listenerAttached) {
      listenerAttached = true
      subscriber.on('message', onMessage)
    }
    if (!channelSubscribed) {
      channelSubscribed = true
      void Promise.resolve(subscriber.subscribe(channel)).catch(() => {
        channelSubscribed = false
      })
    }
  }

  return {
    async publish(event: InvalidationEvent): Promise<void> {
      await publisher.publish(channel, JSON.stringify(event))
    },

    subscribe(handler: (event: InvalidationEvent) => void): () => void {
      wire()
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },

    async close(): Promise<void> {
      handlers.clear()
      if (channelSubscribed) {
        channelSubscribed = false
        await Promise.resolve(subscriber.unsubscribe?.(channel)).catch(() => {})
      }
      if (listenerAttached) {
        listenerAttached = false
        subscriber.off?.('message', onMessage)
      }
    },
  }
}
