import type { PolicyCacheKey } from './types.js'

const PREFIX = 'rbac:v1'

const enc = encodeURIComponent

/**
 * Core-owned key derivation — cache implementations never construct keys.
 *
 * Regression note: v0 derived keys with
 * `[subjectId, domain, tenantId].filter(Boolean).join(':')`, which collides
 * across positions (('u1', null, 'admin') === ('u1', 'admin', null)) and on
 * ':' inside components — one (subject, domain, tenant) tuple could read
 * another's policy map. Fixed arity + encodeURIComponent makes both
 * collisions impossible.
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
