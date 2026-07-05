# Caching policy lookups

Every guarded request needs the subject's policy map. In this guide you tune the built-in cache, invalidate it correctly after direct database writes, and wire cross-instance invalidation so a revoked permission dies everywhere at once.

::: tip Prerequisites
You have guards running ([Protecting routes](/guide/protecting-routes)) and understand how grants are matched per portal and context ([Tenant contexts](/guide/tenant-contexts)).
:::

## What is cached

The engine caches one entry per `(subject, portal, context)` triple: the merged policy map (policy name → scope, `null` meaning unrestricted) that results from the subject's group and direct grants. The key is derived by the core as

```
rbac:v1:<enc(subjectId)>:<enc(portal)>:<enc(contextId)>
```

with each component percent-encoded and empty components kept in position. Portal and context are part of the key because grants are matched by strict equality — a grant with no context never applies to a request with one, and the cache must preserve that separation; this is what keeps tenant data isolated even on the cache path.

Only the policy map is cached. Scope checks such as `Scope.owned()` run on every request, so [ownership](/guide/tracking-ownership) changes take effect immediately regardless of TTL.

## Tuning the default memory cache

`createRbac()` builds a bounded in-memory LRU by default: **10,000 entries, 30 second TTL**. It is bounded because entries scale with the number of distinct active `(subject, portal, context)` triples — an unbounded cache on a busy multi-tenant app grows without limit, so the LRU cap fixes worst-case memory and the TTL puts a ceiling on how long any stale entry can live.

The cache is created inside `createRbac()` and scoped to that instance — nothing is module-level. Two `Rbac` instances in one process cannot read or poison each other's entries, and every test that builds a fresh instance gets a fresh cache for free.

Adjust the defaults without replacing the implementation:

```ts
import { createRbac } from '@kyrobit/rbac'

const rbac = createRbac({
  adapter,
  resources,
  cacheTtlMs: 10_000, // default 30_000
  cacheMaxEntries: 50_000, // default 10_000
})
```

Lower `cacheTtlMs` bounds staleness; higher values reduce storage reads. The TTL is the outer limit for any change that bypasses invalidation entirely.

## Invalidating after permission changes

Two paths:

1. **Automatic — mutations through the library.** `rbac.admin.assignPolicy`, `removePolicy`, `assignGroup`, `removeGroup` and the portal sugar (`portal.assignPolicy(...)` and friends) invalidate the subject's cache entries and publish an invalidation event on the bus, every time.

2. **Manual — direct database writes.** If you write to the rbac tables yourself (an admin UI issuing SQL, a migration, a support script), the engine cannot see it. Invalidate the subject afterwards:

```ts
// Your own write to the rbac tables:
await db.delete(userPolicies).where(eq(userPolicies.userId, 'user_42'))

// Tell the engine — clears every (portal, context) entry for the subject
// and publishes on the invalidation bus:
await rbac.cache.invalidateSubject('user_42')
```

`rbac.cache.clear()` drops everything (and publishes an all-instances clear) — a blunt instrument for bulk permission migrations.

After invalidation the next request re-reads storage, and a subject whose grant was revoked is denied with status 403:

```json
{ "message": "Forbidden", "code": "RBAC_POLICY_DENIED" }
```

## Keeping multiple instances consistent

Each engine invalidates its **own** cache. When you run more than one process, an invalidation must reach the others — that is the invalidation bus. The engine publishes an event after every mutation and invalidates its local cache on every delivery; events are idempotent, so receiving your own publication is harmless. The default bus is in-process only.

`redisBus(publisher, subscriber)` adapts any ioredis-compatible client pair. Redis requires separate connections for publishing and subscribing, hence two clients:

```ts
import { Redis } from 'ioredis'
import { createRbac } from '@kyrobit/rbac'
import { redisBus } from '@kyrobit/rbac/cache'

const publisher = new Redis(process.env.REDIS_URL!)
const subscriber = new Redis(process.env.REDIS_URL!)

const bus = redisBus(publisher, subscriber) // channel 'rbac:invalidate' by default

export const rbac = createRbac({
  adapter,
  resources,
  invalidationBus: bus,
})

// Graceful shutdown: dispose() detaches this engine's handler;
// close() releases the Redis channel subscription (the bus owner's job).
export async function shutdown(): Promise<void> {
  rbac.dispose()
  await bus.close?.()
  publisher.disconnect()
  subscriber.disconnect()
}
```

Pass `{ channel: 'my-app:rbac' }` as the third argument when several apps share one Redis database.

::: danger Without a bus, revocation is delayed on other instances
An invalidation only reaches the instance that performed the mutation. Every other instance keeps serving its cached policy map until that entry's TTL expires — a revoked permission continues to authorize requests there for up to `cacheTtlMs` after the entry was cached (up to 30 seconds with the defaults). If that window is unacceptable, wire the bus; if you cannot, set `cacheTtlMs` to the longest revocation delay you can tolerate.
:::

## Disabling the cache

```ts
const rbac = createRbac({ adapter, resources, cache: false })
```

Every `authorize` call now reads storage directly. This is the right trade in tests (no TTL surprises) and in low-traffic internal tools where a per-request query is cheaper than reasoning about staleness.

## Bringing your own cache

Any object implementing `PolicyCache` can replace the memory cache:

```ts
export interface PolicyCache {
  get(key: PolicyCacheKey): Awaitable<PolicyMap | undefined>
  set(key: PolicyCacheKey, value: PolicyMap): Awaitable<void>
  invalidateSubject(subjectId: string): Awaitable<void>
  clear(): Awaitable<void>
}
```

Keys are constructed by the core — implementations never build their own. `PolicyCacheKey` carries the full encoded `id` plus the raw `subjectId`, `portal` and `contextId`, and `subjectKeyPrefix(subjectId)` gives you the prefix under which all of one subject's keys live, so per-subject invalidation is a prefix operation in external stores.

A Redis-backed cache, shared by all instances:

```ts
import { subjectKeyPrefix } from '@kyrobit/rbac/cache'
import type { PolicyCache, PolicyCacheKey } from '@kyrobit/rbac/cache'
import type { PolicyMap } from '@kyrobit/rbac'
import type { Redis } from 'ioredis'

export function redisPolicyCache(redis: Redis, ttlMs = 30_000): PolicyCache {
  const deleteByPattern = async (pattern: string): Promise<void> => {
    let cursor = '0'
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = next
      if (keys.length > 0) await redis.del(...keys)
    } while (cursor !== '0')
  }

  return {
    async get(key: PolicyCacheKey): Promise<PolicyMap | undefined> {
      const raw = await redis.get(key.id)
      if (raw === null) return undefined
      return new Map(JSON.parse(raw) as [string, string | null][])
    },
    async set(key: PolicyCacheKey, value: PolicyMap): Promise<void> {
      await redis.set(key.id, JSON.stringify([...value.entries()]), 'PX', ttlMs)
    },
    invalidateSubject(subjectId: string): Promise<void> {
      return deleteByPattern(`${subjectKeyPrefix(subjectId)}*`)
    },
    clear(): Promise<void> {
      // Scoped to the rbac prefix — never flush a shared database.
      return deleteByPattern('rbac:v1:*')
    },
  }
}

const rbac = createRbac({ adapter, resources, cache: redisPolicyCache(redis) })
```

A shared cache changes the consistency picture: all instances read the same entries, so `invalidateSubject` on one instance removes the entry for all of them and the staleness window from the danger callout above disappears — at the cost of a network round trip on the authorization hot path.

## Next steps

- [Observing decisions](/guide/observability) — measure hit rate with `onCacheEvent` and audit every decision
- [Testing your app](/guide/testing-your-app) — why tests run with `cache: false`
- [Tracking ownership](/guide/tracking-ownership) — the part of authorization that is never cached
