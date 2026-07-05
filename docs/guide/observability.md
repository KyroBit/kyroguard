# Observing decisions

In this guide you attach an audit hook that sees every allow and deny, export cache hit-rate metrics, and check a deployment's wiring from the command line.

::: tip Prerequisites
You have guarded routes returning real decisions ([Protecting routes](/guide/protecting-routes)). Error codes and status mappings are listed in the [error reference](/reference/errors).
:::

## Auditing every decision with onDecision

Pass `onDecision` to `createRbac()`. The hook fires after **every** authorization decision — allows and denies both — with a `DecisionEvent`:

| Field | Type | Meaning |
| --- | --- | --- |
| `subjectId` | `string` | The subject's id; `''` when the request had no subject at all. |
| `portal` | `string` | The portal the guard ran in; `''` for a portal-less setup. |
| `contextId` | `string` | The tenant context; `''` when none. |
| `policy` | `string` | The fully qualified policy that was checked, e.g. `admin.posts.update`. |
| `decision` | `'allow' \| 'deny'` | The outcome. |
| `reason` | see below | Why the decision fell the way it did. |
| `scope` | `string \| null` | The scope name involved in a scoped decision; `null` for unscoped ones. |
| `cacheHit` | `boolean` | Whether the policy map came from the cache. Always `false` for `super` and `no-subject`, where no lookup happens. |
| `durationMs` | `number` | Wall time from guard entry to decision (a `performance.now()` delta) — includes the storage or cache lookup and any scope check. |

Each `reason` maps to one outcome and, on denies, one thrown error:

| `reason` | Decision | Error thrown | HTTP |
| --- | --- | --- | --- |
| `granted` | allow | — | — |
| `super` | allow (`is_super` bypass) | — | — |
| `no-subject` | deny | `UnauthenticatedError` | 401 `RBAC_UNAUTHENTICATED` |
| `no-policy` | deny | `PolicyDeniedError` | 403 `RBAC_POLICY_DENIED` |
| `scope-denied` | deny | `ScopeDeniedError` | 403 `RBAC_SCOPE_DENIED` |
| `resource-not-found` | deny | `ResourceNotFoundError` | 404 `RBAC_RESOURCE_NOT_FOUND` |

`scope-denied` also fires when a grant names a scope that is not registered, or when the guard has no `resource` resolver for a scoped grant. A missing scope is a deny, never a bypass — failing open on a wiring gap would turn a configuration mistake into an authorization hole.

A concrete pairing: a subject without the grant requests a guarded route. The client sees status 403 with

```json
{ "message": "Forbidden", "code": "RBAC_POLICY_DENIED" }
```

and your hook receives:

```json
{
  "subjectId": "user_42",
  "portal": "admin",
  "contextId": "",
  "policy": "admin.posts.update",
  "decision": "deny",
  "reason": "no-policy",
  "scope": null,
  "cacheHit": true,
  "durationMs": 0.41
}
```

### Shipping decisions to your logger or SIEM

The event is a flat JSON-safe object, so it forwards as-is:

```ts
import pino from 'pino'
import { createRbac } from '@kyrobit/rbac'
import type { DecisionEvent } from '@kyrobit/rbac'

const logger = pino()

const rbac = createRbac({
  adapter,
  resources,
  onDecision(event: DecisionEvent) {
    if (event.decision === 'deny') {
      // Denies are your security signal — keep them at a visible level.
      logger.warn({ rbac: event }, 'rbac deny')
    } else {
      logger.debug({ rbac: event }, 'rbac allow')
    }
  },
})
```

For a SIEM, push the same object onto your transport (HTTP batcher, Kafka producer, syslog). Useful standing queries: denies per subject per minute (probing), `reason: 'scope-denied'` spikes after a deploy (a guard lost its `resource` resolver), and p99 `durationMs` with `cacheHit: false` (storage latency on the authorization path).

::: warning Hook errors are swallowed — by design
`onDecision` runs synchronously on the request path, and anything it throws is caught and discarded: authorization never depends on observability, so a broken logger cannot cause an outage or change a decision. The flip side is that a throwing hook drops audit events without any trace. Keep the hook body minimal — enqueue and return — and put retries or network I/O behind an async transport whose failures you monitor separately.
:::

## Measuring cache performance with onCacheEvent

`onCacheEvent` receives every cache interaction: `{ type, subjectId? }` where `type` is `'hit'`, `'miss'`, `'set'`, `'invalidate-subject'` or `'clear'` (`subjectId` is absent on `clear`). Errors are swallowed under the same rule as `onDecision`.

```ts
import { createRbac } from '@kyrobit/rbac'
import type { CacheEvent } from '@kyrobit/rbac'

const counts: Record<CacheEvent['type'], number> = {
  hit: 0,
  miss: 0,
  set: 0,
  'invalidate-subject': 0,
  clear: 0,
}

const rbac = createRbac({
  adapter,
  resources,
  onCacheEvent(event) {
    counts[event.type] += 1
  },
})

// Expose wherever your metrics live:
app.get('/internal/rbac-cache', async () => ({
  ...counts,
  hitRate: counts.hit / Math.max(1, counts.hit + counts.miss),
}))
```

How to read it: a persistently low hit rate means the TTL is shorter than your request patterns or most subjects are seen once per TTL window; a high `invalidate-subject` volume means assignment churn is defeating the cache. Both are tuning inputs for [Caching](/guide/caching).

## Checking a deployment with rbac status

`rbac status` is the CLI diagnostic. It loads `rbac.config.ts` (pass `--config <path>` to point elsewhere), opens the adapter, and prints what storage actually contains:

```sh
npx rbac status
```

```
adapter:      drizzle-pg
capabilities: autoOwnershipTracking=true queryScoping=true
policies:     12
groups:       3
```

- `adapter` — which storage backend the config resolves to (`drizzle-pg`, `drizzle-mysql`, `drizzle-sqlite`, `prisma`, `mongoose`, `memory`).
- `capabilities` — whether automatic [ownership tracking](/guide/tracking-ownership) and query scoping are available on this backend.
- `policies` / `groups` — stored counts. `policies: 0` on a configured app means `rbac sync` has not run.

On failure it prints `[rbac] status failed: <message>` and exits with code 1, which makes it a usable smoke check in a deploy pipeline: it proves the config file loads, the database is reachable, and sync has populated storage — before the first real request finds out otherwise.

## Next steps

- [Caching](/guide/caching) — act on the hit-rate numbers you now collect
- [Error reference](/reference/errors) — every `RBAC_*` code, status and default body
- [Testing your app](/guide/testing-your-app) — assert on decisions instead of logging them
