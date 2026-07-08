import type { PolicyCacheKey } from './types.js'

// Bump the version segment whenever the cached PolicyMap value shape changes —
// a stale-format entry must never be readable (v2: values became scope arrays).
const PREFIX = 'kyroguard:v2'

const enc = encodeURIComponent

/**
 * Core-owned key derivation — cache implementations never construct keys.
 * Fixed arity + per-component encoding are load-bearing: positional or ':'
 * collisions would let one (subject, domain, tenant) read another's policy map.
 */
export function policyCacheKey(subjectId: string, domain: string, tenantId: string): PolicyCacheKey {
  return {
    id: `${PREFIX}:${enc(subjectId)}:${enc(domain)}:${enc(tenantId)}`,
    subjectId,
    domain,
    tenantId,
  }
}

/** Prefix for all of one subject's keys — for prefix-scan invalidation. */
export function subjectKeyPrefix(subjectId: string): string {
  return `${PREFIX}:${enc(subjectId)}:`
}
