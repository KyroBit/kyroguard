import type { InvalidationBus, InvalidationEvent } from './types.js'

/** Default single-process bus: synchronous fan-out to local subscribers. */
export function inProcessBus(): InvalidationBus {
  const handlers = new Set<(event: InvalidationEvent) => void>()

  return {
    publish(event: InvalidationEvent): void {
      for (const handler of [...handlers]) {
        try {
          handler(event)
        } catch {
          // One failing handler must not block delivery to the rest.
        }
      }
    },

    subscribe(handler: (event: InvalidationEvent) => void): () => void {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },

    close(): void {
      handlers.clear()
    },
  }
}
