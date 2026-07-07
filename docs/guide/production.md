# Running in production

## Caching

Grants are cached in memory for 30 seconds by default. That cuts the database out of most requests. The cost: a revoked permission can outlive revocation by up to 30 seconds on other servers.

```ts
const guard = createKyroguard({
  adapter,
  policies,
  groups,
  cacheTtlMs: 10_000,      // default 30_000
  cacheMaxEntries: 50_000, // default 10_000
})
```

Assigning or revoking through this library clears that server's cache immediately. Other servers wait out the TTL — unless you connect them (next section). Pass `cache: false` to turn caching off.

## Multiple servers

Each server caches on its own. Connect them with `redisBus` so a revocation on one server clears all of them:

```ts
import { Redis } from 'ioredis'
import { createKyroguard } from '@kyrobit/kyroguard'
import { redisBus } from '@kyrobit/kyroguard/cache'

const publisher = new Redis(process.env.REDIS_URL!)
const subscriber = new Redis(process.env.REDIS_URL!)

const guard = createKyroguard({
  adapter,
  policies,
  groups,
  invalidationBus: redisBus(publisher, subscriber),
})
```

Redis needs one connection for publishing and one for subscribing, so pass two clients. Nothing else changes.

## Audit log

`onDecision` fires after every allow and deny. Ship it to your logger:

```ts
const guard = createKyroguard({
  adapter,
  policies,
  groups,
  onDecision: event => {
    logger.info({
      user: event.subjectId,
      policy: event.policy,
      decision: event.decision,
      reason: event.reason,
      durationMs: event.durationMs,
    })
  },
})
```

`reason` says why: `granted`, `super`, `no-policy`, `scope-denied`, `no-subject` or `resource-not-found`. An error thrown inside the hook is ignored. The hook can never block or change a decision.

## Health check

`kyroguard status` confirms the app can reach its policy tables:

```
$ npx kyroguard status
adapter:      drizzle-pg
capabilities: autoOwnershipTracking=true queryScoping=true
policies:     7
groups:       2
```

Zero policies after a deploy means `kyroguard sync` has not run. See [Sync](/guide/sync).
