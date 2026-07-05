# Cache

Reference for `@kyrobit/rbac/cache`: cache and bus implementations, key helpers, and the interfaces for custom caches. For usage guidance, see [Production](/guide/production).

## memoryCache()

```ts
import { memoryCache } from '@kyrobit/rbac/cache'

function memoryCache(options: MemoryCacheOptions): PolicyCache
```

| Option | Type | Description |
| --- | --- | --- |
| `maxEntries` | `number` | Size limit. Least recently used entries are evicted first. |
| `ttlMs` | `number` | Lifetime per entry. |

An in-memory cache with a size limit and per-entry TTL. `createRbac()` builds one by default (`maxEntries: 10_000`, `ttlMs: 30_000`). Pass your own to change the limits:

```ts
import { createRbac } from '@kyrobit/rbac'
import { memoryCache } from '@kyrobit/rbac/cache'

const rbac = createRbac({
  adapter,
  cache: memoryCache({ maxEntries: 50_000, ttlMs: 10_000 }),
})
```

## inProcessBus()

```ts
import { inProcessBus } from '@kyrobit/rbac/cache'

function inProcessBus(): InvalidationBus
```

The default bus. It delivers invalidation events inside one process. Running several instances behind a load balancer? Use `redisBus()` instead, so a grant change on one instance clears the others' caches.

## redisBus()

```ts
import { redisBus } from '@kyrobit/rbac/cache'

function redisBus(
  publisher: RedisPublisherLike,
  subscriber: RedisSubscriberLike,
  options?: RedisBusOptions,
): InvalidationBus
```

| Parameter | Description |
| --- | --- |
| `publisher` | Redis client used to publish. Any ioredis-compatible client works. |
| `subscriber` | Second Redis client used to subscribe. |
| `options.channel` | Pub/sub channel name. Default `'rbac:invalidate'`. |

Cross-instance invalidation over Redis pub/sub. The module never imports a Redis driver — you pass the clients in.

```ts
import { Redis } from 'ioredis'
import { createRbac } from '@kyrobit/rbac'
import { redisBus } from '@kyrobit/rbac/cache'

const publisher = new Redis(process.env.REDIS_URL!)
const subscriber = new Redis(process.env.REDIS_URL!)

const bus = redisBus(publisher, subscriber)
const rbac = createRbac({ adapter, invalidationBus: bus })

// shutdown:
await bus.close()
```

Malformed messages and other channels are ignored. `close()` unsubscribes and detaches the listener.

::: warning
Redis needs separate connections for publishing and subscribing. A connection in subscriber mode rejects other commands. Passing the same client twice breaks `publish()`.
:::

### Client interfaces

```ts
interface RedisPublisherLike {
  publish(channel: string, message: string): Awaitable<unknown>
}

interface RedisSubscriberLike {
  subscribe(channel: string): Awaitable<unknown>
  on(event: 'message', listener: (channel: string, message: string) => void): unknown
  unsubscribe?(channel: string): Awaitable<unknown>
  off?(event: 'message', listener: (channel: string, message: string) => void): unknown
}
```

## Key helpers

```ts
import { policyCacheKey, subjectKeyPrefix } from '@kyrobit/rbac/cache'

function policyCacheKey(subjectId: string, domain: string, tenantId: string): PolicyCacheKey
function subjectKeyPrefix(subjectId: string): string
```

The core builds every cache key with `policyCacheKey()`. Custom caches never build key strings themselves. `subjectKeyPrefix()` returns the prefix shared by one user's keys. Use it to find and delete a user's entries in Redis (`SCAN MATCH`).

## PolicyCache

Implement this interface for a custom cache (Redis, memcached, ...):

```ts
interface PolicyCache {
  get(key: PolicyCacheKey): Awaitable<PolicyMap | undefined>  // return undefined on miss
  set(key: PolicyCacheKey, value: PolicyMap): Awaitable<void> // store the merged policy map
  invalidateSubject(subjectId: string): Awaitable<void>       // drop all of one user's entries
  clear(): Awaitable<void>                                    // drop everything
}

interface PolicyCacheKey {
  id: string        // full encoded key — use as the storage key
  subjectId: string // raw components, for stores that index differently
  domain: string
  tenantId: string
}
```

Methods may be synchronous or return a promise. `invalidateSubject` must match the raw `subjectId` component, or use `subjectKeyPrefix()`.

## InvalidationBus

Implement this interface for a custom transport (NATS, Postgres LISTEN/NOTIFY, ...):

```ts
type InvalidationEvent = { type: 'subject'; subjectId: string } | { type: 'all' }

interface InvalidationBus {
  publish(event: InvalidationEvent): Awaitable<void>                    // broadcast to other instances
  subscribe(handler: (event: InvalidationEvent) => void): () => void    // returns unsubscribe
  close?(): Awaitable<void>                                             // release the transport
}
```

The engine publishes after every grant change. It clears its local cache on every delivered event. Receiving your own published event back is harmless. Call `close()` yourself at shutdown — `rbac.dispose()` only detaches the engine's own handler.

## CacheEvent

```ts
interface CacheEvent {
  type: 'hit' | 'miss' | 'set' | 'invalidate-subject' | 'clear'
  subjectId?: string // absent on 'clear'
}

type CacheHook = (event: CacheEvent) => void
```

Emitted through `onCacheEvent` on [`createRbac()`](/reference/core-api#createrbac). Errors thrown by the hook are swallowed. Observability never affects authorization.
