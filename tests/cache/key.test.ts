/// <reference types="bun-types" />
import { describe, test, expect } from 'bun:test'
import { policyCacheKey, subjectKeyPrefix } from '../../src/cache/key.js'

describe('policyCacheKey collision-proofing', () => {
  test('components in different positions never collide', () => {
    const a = policyCacheKey('u1', '', 'admin')
    const b = policyCacheKey('u1', 'admin', '')
    expect(a.id).not.toBe(b.id)
  })

  test("':' inside a component cannot fake a component boundary", () => {
    const smuggled = policyCacheKey('u1:admin', '', '')
    const portalPos = policyCacheKey('u1', 'admin', '')
    const contextPos = policyCacheKey('u1', '', 'admin')
    expect(smuggled.id).not.toBe(portalPos.id)
    expect(smuggled.id).not.toBe(contextPos.id)
    expect(portalPos.id).not.toBe(contextPos.id)
  })

  test("':' in every component stays distinct in every position", () => {
    const ids = [
      policyCacheKey('a:b', 'c', 'd'),
      policyCacheKey('a', 'b:c', 'd'),
      policyCacheKey('a', 'b', 'c:d'),
      policyCacheKey('a', 'b:c:d', ''),
      policyCacheKey('a:b:c:d', '', ''),
      policyCacheKey('', 'a:b:c:d', ''),
      policyCacheKey('', '', 'a:b:c:d'),
    ].map((k) => k.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('unicode in every component round-trips into distinct ids', () => {
    const ids = [
      policyCacheKey('用户:1', 'портал', 'ctx🙂'),
      policyCacheKey('用户', ':1портал', 'ctx🙂'),
      policyCacheKey('用户', '1', 'портал:ctx🙂'),
      policyCacheKey('ü', 'ü', ''), // precomposed vs combining must differ
      policyCacheKey('ü', 'ü', ''),
    ].map((k) => k.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('key carries the raw (unencoded) components', () => {
    const k = policyCacheKey('u:1', 'p 2', 'c/3')
    expect(k.subjectId).toBe('u:1')
    expect(k.portal).toBe('p 2')
    expect(k.contextId).toBe('c/3')
  })

  test('empty components stay in position', () => {
    const ids = [
      policyCacheKey('', '', ''),
      policyCacheKey('x', '', ''),
      policyCacheKey('', 'x', ''),
      policyCacheKey('', '', 'x'),
    ].map((k) => k.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('subjectKeyPrefix', () => {
  const portals = ['', 'admin', 'a:b', '用户']
  const contexts = ['', 'ctx', 'c:d', '🙂']

  test("is a prefix of every one of that subject's key ids", () => {
    const prefix = subjectKeyPrefix('u1')
    for (const portal of portals) {
      for (const contextId of contexts) {
        expect(policyCacheKey('u1', portal, contextId).id.startsWith(prefix)).toBe(true)
      }
    }
  })

  test("is NOT a prefix of any other subject's key ids (v0 startsWith over-clear regression)", () => {
    const u1Prefix = subjectKeyPrefix('u1')
    for (const other of ['u1x', 'u', 'u1:', 'u12']) {
      for (const portal of portals) {
        for (const contextId of contexts) {
          expect(policyCacheKey(other, portal, contextId).id.startsWith(u1Prefix)).toBe(false)
        }
      }
    }
  })

  test("shorter subject's prefix does not match a longer subject's keys", () => {
    // 'u' vs 'u1': subjectKeyPrefix('u') must not capture u1's keys.
    const uPrefix = subjectKeyPrefix('u')
    for (const portal of portals) {
      for (const contextId of contexts) {
        expect(policyCacheKey('u1', portal, contextId).id.startsWith(uPrefix)).toBe(false)
      }
    }
  })

  test("subject containing ':' cannot escape its prefix segment", () => {
    const prefix = subjectKeyPrefix('u1:admin')
    expect(policyCacheKey('u1:admin', 'p', 'c').id.startsWith(prefix)).toBe(true)
    expect(policyCacheKey('u1', 'admin', 'c').id.startsWith(prefix)).toBe(false)
    expect(policyCacheKey('u1', 'admin:p', 'c').id.startsWith(subjectKeyPrefix('u1:admin'))).toBe(false)
  })
})