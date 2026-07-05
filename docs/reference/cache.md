# Cache

Reference for `@kyrobit/rbac/cache`: the policy cache and invalidation bus implementations, key helpers, and the interfaces you implement for a custom cache. For usage guidance, see [Caching](/guide/caching).

## memoryCache()

```ts
import { memoryCache } from '@kyrobit/rbac/cache'

function memoryCache(options: MemoryCacheOptions): PolicyCache

interface MemoryCacheOptions {
  maxEntries: number
  ttlMs: number
}
```

Bounded in-memory LRU with per-entry TTL. Recency is `Map` insertion order: `get()` re-inserts the entry, eviction removes the least recently used key once `maxEntries` is exceeded. Expired entries are dropped on read. `invalidateSubject()` compares the stored raw subject id exactly — it never prefix-matches the encoded key id, which could cross subject boundaries.

`createRbac()` builds one for you by default (`maxEntries: 10_000`, `ttlMs: 30_000`); pass one explicitly to change both values in one place, or use `cacheTtlMs`/`cacheMaxEntries` on [`CreateRbacOptions`](/reference/core-api#createrbacoptions).

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

Default single-process bus: `publish()` fans out synchronously to local subscribers. One failing handler does not block delivery to the rest. `close()` clears all handlers. Sufficient for a single Node process; with multiple instances behind a load balancer, use `redisBus()` so a grant change on one instance invalidates the others' caches.

## redisBus()

```ts
import { redisBus } from '@kyrobit/rbac/cache'

function redisBus(
  publisher: RedisPublisherLike,
  subscriber: RedisSubscriberLike,
  options?: RedisBusOptions,
): InvalidationBus

interface RedisBusOptions {
  channel?: string // default 'rbac:invalidate'
}
```

Cross-instance invalidation over Redis pub/sub. The clients are dependency-injected — this module never imports a Redis driver. Behavior:

- **Lazy wiring** — no Redis traffic until something subscribes. A failed `SUBSCRIBE` resets internal state so the next `subscribe()` retries.
- `publish()` only goes to Redis: the engine already invalidated its local cache before publishing, and the self-delivered copy is an idempotent no-op.
- Malformed messages and messages on other channels are ignored.
- `close()` unsubscribes from the channel and detaches the message listener.

### Client interfaces

Structural slices of an ioredis-compatible client pair:

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

::: warning
Redis requires separate connections for publishing and subscribing — a connection in subscriber mode rejects other commands. Passing the same client as both parameters breaks `publish()` once the subscription is wired.
:::

## Key helpers

Core-owned key derivation — cache implementations never construct keys themselves.

### policyCacheKey()

```ts
import { policyCacheKey } from '@kyrobit/rbac/cache'

function policyCacheKey(subjectId: string, portal: string, contextId: string): PolicyCacheKey
```

Returns the key with `id` = `` `rbac:v1:<enc(subjectId)>:<enc(portal)>:<enc(contextId)>` `` where `enc` is `encodeURIComponent`. Fixed arity and per-component encoding make collisions impossible: a `:` inside a component is escaped, and empty components stay in position — `('u1', '', 'ctx')` and `('u1', 'ctx', '')` produce different ids. Without this, one security context could read another's policy map.

### subjectKeyPrefix()

```ts
import { subjectKeyPrefix } from '@kyrobit/rbac/cache'

function subjectKeyPrefix(subjectId: string): string
```

Returns `` `rbac:v1:<enc(subjectId)>:` `` — the prefix of all of one subject's keys, for prefix-scan invalidation in external stores (e.g. Redis `SCAN MATCH`).

## Interfaces for implementers

### PolicyCache

```ts
interface PolicyCache {
  get(key: PolicyCacheKey): Awaitable<PolicyMap | undefined>
  set(key: PolicyCacheKey, value: PolicyMap): Awaitable<void>
  invalidateSubject(subjectId: string): Awaitable<void>
  clear(): Awaitable<void>
}

interface PolicyCacheKey {
  id: string        // full encoded key
  subjectId: string // raw components, for stores that index differently
  portal: string
  contextId: string
}
```

Every method may be synchronous or return a promise. `invalidateSubject` must remove all entries whose **raw** `subjectId` matches — use the stored component or `subjectKeyPrefix()`, never a substring match on unencoded ids. The cache is created inside `createRbac()` and is instance-scoped, so two apps in one process cannot poison each other's entries.

### InvalidationBus

```ts
type InvalidationEvent = { type: 'subject'; subjectId: string } | { type: 'all' }

interface InvalidationBus {
  publish(event: InvalidationEvent): Awaitable<void>
  subscribe(handler: (event: InvalidationEvent) => void): () => void // returns unsubscribe
  close?(): Awaitable<void>
}
```

The engine publishes after every assignment mutation it performs and invalidates its local cache on every delivery. Events are idempotent, so an implementation may deliver a publication back to its publisher — the duplicate invalidation is harmless. `subscribe()` is synchronous by contract and returns an unsubscribe function. `close()` is optional: release the underlying transport (e.g. the Redis channel subscription). The bus owner calls `close()` at shutdown — `engine.dispose()` only detaches the engine's own handler, because the bus may be shared by several engines.

### CacheEvent, CacheHook

```ts
interface CacheEvent {
  type: 'hit' | 'miss' | 'set' | 'invalidate-subject' | 'clear'
  subjectId?: string // absent on 'clear'
}

type CacheHook = (event: CacheEvent) => void
```

Emitted through `onCacheEvent` on [`CreateRbacOptions`](/reference/core-api#createrbacoptions). Errors thrown by the hook are swallowed — observability must never affect authorization. See [Observability](/guide/observability).
