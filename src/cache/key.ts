import type { PolicyCacheKey } from './types.js'

const PREFIX = 'rbac:v1'

const enc = encodeURIComponent

/**
 * Core-owned key derivation — cache implementations never construct keys.
 *
 * Regression note: v0 derived keys with
 * `[subjectId, portal, contextId].filter(Boolean).join(':')`, which collides
 * across positions (('u1', null, 'admin') === ('u1', 'admin', null)) and on
 * ':' inside components — one security context could read another's policy
 * map. Fixed arity + encodeURIComponent makes both collisions impossible.
 */
export function policyCacheKey(subjectId: string, portal: string, contextId: string): PolicyCacheKey {
  return {
    id: `${PREFIX}:${enc(subjectId)}:${enc(portal)}:${enc(contextId)}`,
    subjectId,
    portal,
    contextId,
  }
}

/** Prefix for all of one subject's keys — for prefix-scan invalidation. */
export function subjectKeyPrefix(subjectId: string): string {
  return `${PREFIX}:${enc(subjectId)}:`
}
