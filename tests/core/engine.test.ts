import { describe, test, expect } from 'bun:test'
import { RbacEngine, mergeGrants } from '../../src/core/engine.js'
import { Scope } from '../../src/core/scope.js'
import {
  PolicyDeniedError,
  ResourceNotFoundError,
  ScopeDeniedError,
  UnauthenticatedError,
} from '../../src/core/errors.js'
import { inProcessBus } from '../../src/cache/bus.js'
import { memoryAdapter } from '../../src/testing/index.js'
import type { EngineOptions } from '../../src/core/engine.js'
import type { ScopeCheckContext } from '../../src/core/scope.js'
import type { ResourceRef, Subject, SubjectRef } from '../../src/core/types.js'
import { UnknownScopeError } from '../../src/storage/contract.js'
import type { PolicyGrant, StorageAdapter } from '../../src/storage/contract.js'

interface Harness {
  adapter: StorageAdapter
  engine: RbacEngine
}

function makeEngine(overrides?: Partial<EngineOptions>): Harness {
  const adapter = overrides?.adapter ?? memoryAdapter()
  const engine = new RbacEngine({
    adapter,
    scopes: new Map(),
    cache: null,
    bus: inProcessBus(),
    ...overrides,
  })
  return { adapter, engine }
}

/** Sync a policy and grant it directly to the given tuple. */
async function grant(
  adapter: StorageAdapter,
  ref: SubjectRef,
  policy: string,
  scope: string | null = null,
): Promise<void> {
  await adapter.upsertPolicies([
    { name: policy, domain: ref.domain, label: policy, scopeOptions: scope ? [scope] : [], dependsOn: [] },
  ])
  await adapter.assignPolicy(ref, policy, scope)
}

describe('authorize() decision matrix', () => {
  test('no subject → UnauthenticatedError (401)', async () => {
    const { engine } = makeEngine()
    const err = await engine.authorize(null, 'admin.posts.read').then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(UnauthenticatedError)
    expect((err as UnauthenticatedError).statusCode).toBe(401)
    expect((err as UnauthenticatedError).code).toBe('RBAC_UNAUTHENTICATED')
  })

  test('undefined subject → UnauthenticatedError', async () => {
    const { engine } = makeEngine()
    expect(engine.authorize(undefined, 'admin.posts.read')).rejects.toBeInstanceOf(
      UnauthenticatedError,
    )
  })

  test('empty subject id → UnauthenticatedError', async () => {
    const { engine } = makeEngine()
    expect(engine.authorize({ id: '' }, 'admin.posts.read')).rejects.toBeInstanceOf(
      UnauthenticatedError,
    )
  })

  test('policy not granted → PolicyDeniedError with code RBAC_POLICY_DENIED (403)', async () => {
    const { engine } = makeEngine()
    const err = await engine.authorize({ id: 'u1' }, 'admin.posts.read').then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(PolicyDeniedError)
    expect((err as PolicyDeniedError).statusCode).toBe(403)
    expect((err as PolicyDeniedError).code).toBe('RBAC_POLICY_DENIED')
    expect((err as PolicyDeniedError).policy).toBe('admin.posts.read')
  })

  test('granted policy → resolves (200-equivalent)', async () => {
    const { adapter, engine } = makeEngine()
    await grant(adapter, { subjectId: 'u1', domain: 'admin', tenantId: '' }, 'admin.posts.read')
    await engine.authorize({ id: 'u1', domain: 'admin' }, 'admin.posts.read')
  })

  test('domain isolation: grant on admin domain, subject on branch domain → deny', async () => {
    const { adapter, engine } = makeEngine()
    await grant(adapter, { subjectId: 'u1', domain: 'admin', tenantId: '' }, 'admin.posts.read')
    expect(
      engine.authorize({ id: 'u1', domain: 'branch' }, 'admin.posts.read'),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
  })

  test('tenant isolation: grant at tenant b1, subject at tenant b2 → deny', async () => {
    const { adapter, engine } = makeEngine()
    await grant(
      adapter,
      { subjectId: 'u1', domain: 'branch', tenantId: 'b1' },
      'branch.posts.read',
    )
    expect(
      engine.authorize({ id: 'u1', domain: 'branch', tenant_id: 'b2' }, 'branch.posts.read'),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
  })

  test('null-tenant grant does NOT match explicit-tenant subject (v0 global-fallback regression)', async () => {
    const { adapter, engine } = makeEngine()
    // Granted with no tenant (empty-string sentinel).
    await grant(adapter, { subjectId: 'u1', domain: 'branch', tenantId: '' }, 'branch.posts.read')
    // Subject inside a tenant must NOT inherit the tenant-less grant.
    expect(
      engine.authorize({ id: 'u1', domain: 'branch', tenant_id: 'b1' }, 'branch.posts.read'),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
  })

  test('explicit-tenant grant does NOT match null-tenant subject (reverse direction)', async () => {
    const { adapter, engine } = makeEngine()
    await grant(
      adapter,
      { subjectId: 'u1', domain: 'branch', tenantId: 'b1' },
      'branch.posts.read',
    )
    // Subject with no tenant must NOT see the tenant-bound grant.
    expect(
      engine.authorize({ id: 'u1', domain: 'branch' }, 'branch.posts.read'),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
  })
})

describe('authorize() scoped grants', () => {
  const ref: SubjectRef = { subjectId: 'u1', domain: 'admin', tenantId: '' }
  const subject: Subject = { id: 'u1', domain: 'admin' }
  const resource: ResourceRef = { type: 'post', id: 'p1' }

  test('no resource resolver → the scope decides on null (row scope fails closed)', async () => {
    // A row scope like Scope.owned() must deny when there is no row to check.
    const scopes = new Map([
      ['owned', new Scope('owned', 'Owned', (_s, r) => (r ? true : false))],
    ])
    const { adapter, engine } = makeEngine({ scopes })
    await grant(adapter, ref, 'admin.posts.update', 'owned')
    const err = await engine.authorize(subject, 'admin.posts.update').then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ScopeDeniedError)
    expect((err as ScopeDeniedError).code).toBe('RBAC_SCOPE_DENIED')
    expect((err as ScopeDeniedError).scope).toBe('owned')
  })

  test('no resource resolver → a condition scope can allow (business hours)', async () => {
    // Condition scopes ignore the row entirely — no resolver needed.
    const withinHours = new Scope('business-hours', 'Business hours', () => true)
    const scopes = new Map([['business-hours', withinHours]])
    const { adapter, engine } = makeEngine({ scopes })
    await grant(adapter, ref, 'admin.sales.void', 'business-hours')
    await engine.authorize(subject, 'admin.sales.void')
  })

  test('no resource resolver → the scope receives resource null', async () => {
    let seenResource: ResourceRef | null | undefined
    const scopes = new Map([
      [
        'any',
        new Scope('any', 'Any', (_s, r) => {
          seenResource = r
          return true
        }),
      ],
    ])
    const { adapter, engine } = makeEngine({ scopes })
    await grant(adapter, ref, 'admin.posts.update', 'any')
    await engine.authorize(subject, 'admin.posts.update')
    expect(seenResource).toBeNull()
  })

  test('Scope.owned() fails closed without a resource', async () => {
    const owned = Scope.owned()
    const scopes = new Map([[owned.name, owned]])
    const { adapter, engine } = makeEngine({ scopes })
    await grant(adapter, ref, 'admin.posts.update', 'owned')
    await expect(engine.authorize(subject, 'admin.posts.update')).rejects.toBeInstanceOf(
      ScopeDeniedError,
    )
  })

  test('resource resolver returns null → ResourceNotFoundError (404)', async () => {
    const scopes = new Map([['owned', new Scope('owned', 'Owned', () => true)]])
    const { adapter, engine } = makeEngine({ scopes })
    await grant(adapter, ref, 'admin.posts.update', 'owned')
    const err = await engine
      .authorize(subject, 'admin.posts.update', { resource: () => null })
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(ResourceNotFoundError)
    expect((err as ResourceNotFoundError).statusCode).toBe(404)
    expect((err as ResourceNotFoundError).code).toBe('RBAC_RESOURCE_NOT_FOUND')
  })

  test('scope check returns false → ScopeDeniedError', async () => {
    const scopes = new Map([['owned', new Scope('owned', 'Owned', () => false)]])
    const { adapter, engine } = makeEngine({ scopes })
    await grant(adapter, ref, 'admin.posts.update', 'owned')
    expect(
      engine.authorize(subject, 'admin.posts.update', { resource: () => resource }),
    ).rejects.toBeInstanceOf(ScopeDeniedError)
  })

  test('scope check returns true → allow', async () => {
    const scopes = new Map([['owned', new Scope('owned', 'Owned', () => true)]])
    const { adapter, engine } = makeEngine({ scopes })
    await grant(adapter, ref, 'admin.posts.update', 'owned')
    await engine.authorize(subject, 'admin.posts.update', { resource: () => resource })
  })

  test('unknown scope name in the grant → ScopeDeniedError (fail closed)', async () => {
    // Registry has 'owned'; the grant references 'mystery' which no code defines.
    const scopes = new Map([['owned', new Scope('owned', 'Owned', () => true)]])
    const { adapter, engine } = makeEngine({ scopes })
    await grant(adapter, ref, 'admin.posts.update', 'mystery')
    const err = await engine
      .authorize(subject, 'admin.posts.update', { resource: () => resource })
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(ScopeDeniedError)
    expect((err as ScopeDeniedError).scope).toBe('mystery')
  })

  test('scope check receives (subject, resource, { db, adapter })', async () => {
    const db = { tag: 'the-db-handle' }
    let seen: { subject: Subject; resource: ResourceRef | null; ctx: ScopeCheckContext } | null =
      null
    const scopes = new Map([
      [
        'owned',
        new Scope('owned', 'Owned', (s, r, ctx) => {
          seen = { subject: s, resource: r, ctx }
          return true
        }),
      ],
    ])
    const { adapter, engine } = makeEngine({ scopes, db })
    await grant(adapter, ref, 'admin.posts.update', 'owned')
    await engine.authorize(subject, 'admin.posts.update', { resource: () => resource })

    expect(seen).not.toBeNull()
    const captured = seen! as {
      subject: Subject
      resource: ResourceRef | null
      ctx: ScopeCheckContext
    }
    expect(captured.subject).toBe(subject)
    expect(captured.resource).toEqual(resource)
    expect(captured.ctx.db).toBe(db)
    expect(captured.ctx.adapter).toBe(adapter)
  })

  test('async scope checks are awaited (allow and deny)', async () => {
    const scopes = new Map([
      [
        'owned',
        new Scope('owned', 'Owned', async (_s, r) => {
          await Promise.resolve()
          return r?.id === 'p1'
        }),
      ],
    ])
    const { adapter, engine } = makeEngine({ scopes })
    await grant(adapter, ref, 'admin.posts.update', 'owned')

    await engine.authorize(subject, 'admin.posts.update', {
      resource: async () => ({ type: 'post', id: 'p1' }),
    })
    expect(
      engine.authorize(subject, 'admin.posts.update', {
        resource: async () => ({ type: 'post', id: 'p2' }),
      }),
    ).rejects.toBeInstanceOf(ScopeDeniedError)
  })
})

describe('super bypass', () => {
  test('superBypass true (default): is_super === true allows without any grants', async () => {
    const { engine } = makeEngine()
    await engine.authorize({ id: 'root', is_super: true }, 'admin.anything.at-all')
  })

  test('superBypass false: is_super is ignored', async () => {
    const { engine } = makeEngine({ superBypass: false })
    expect(
      engine.authorize({ id: 'root', is_super: true }, 'admin.posts.read'),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
  })

  test("is_super must be boolean true — string 'true' does NOT bypass (regression)", async () => {
    const { engine } = makeEngine()
    const subject = { id: 'root', is_super: 'true' } as unknown as Subject
    expect(engine.authorize(subject, 'admin.posts.read')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    )
  })

  test('is_super truthy non-boolean (1) does NOT bypass', async () => {
    const { engine } = makeEngine()
    const subject = { id: 'root', is_super: 1 } as unknown as Subject
    expect(engine.authorize(subject, 'admin.posts.read')).rejects.toBeInstanceOf(
      PolicyDeniedError,
    )
  })
})

describe('mergeGrants precedence', () => {
  test('null scope wins over a named scope (either order)', () => {
    const a: PolicyGrant[] = [
      { name: 'p', scope: 'owned' },
      { name: 'p', scope: null },
    ]
    expect(mergeGrants(a).get('p')).toBeNull()

    const b: PolicyGrant[] = [
      { name: 'p', scope: null },
      { name: 'p', scope: 'owned' },
    ]
    expect(mergeGrants(b).get('p')).toBeNull()
  })

  test('null wins even after scopes accumulated, and later named scopes never displace it', () => {
    const grants: PolicyGrant[] = [
      { name: 'p', scope: 'first' },
      { name: 'p', scope: 'second' },
      { name: 'p', scope: null },
      { name: 'p', scope: 'third' },
    ]
    expect(mergeGrants(grants).get('p')).toBeNull()
  })

  test('two named scopes union in grant order', () => {
    const grants: PolicyGrant[] = [
      { name: 'p', scope: 'first' },
      { name: 'p', scope: 'second' },
    ]
    expect(mergeGrants(grants).get('p')).toEqual(['first', 'second'])
  })

  test('union dedupes while keeping first-seen order stable', () => {
    const grants: PolicyGrant[] = [
      { name: 'p', scope: 'b' },
      { name: 'p', scope: 'a' },
      { name: 'p', scope: 'b' },
      { name: 'p', scope: 'a' },
    ]
    expect(mergeGrants(grants).get('p')).toEqual(['b', 'a'])
  })

  test('duplicate grants collapse to one entry', () => {
    const grants: PolicyGrant[] = [
      { name: 'p', scope: 'owned' },
      { name: 'p', scope: 'owned' },
      { name: 'q', scope: null },
      { name: 'q', scope: null },
    ]
    const map = mergeGrants(grants)
    expect(map.size).toBe(2)
    expect(map.get('p')).toEqual(['owned'])
    expect(map.get('q')).toBeNull()
  })
})

describe('authorize() any-scope-passes', () => {
  const subject: Subject = { id: 'u1', domain: 'admin' }
  const resource: ResourceRef = { type: 'post', id: 'p1' }

  /** Adapter whose getSubjectPolicies returns fixed grants — the only way to hold one policy under two scopes. */
  function multiGrantAdapter(grants: PolicyGrant[]): StorageAdapter {
    return { ...memoryAdapter(), getSubjectPolicies: async () => grants }
  }

  test('two scopes, first fails, second passes → allow', async () => {
    const scopes = new Map([
      ['first', new Scope('first', 'First', () => false)],
      ['second', new Scope('second', 'Second', () => true)],
    ])
    const adapter = multiGrantAdapter([
      { name: 'admin.posts.update', scope: 'first' },
      { name: 'admin.posts.update', scope: 'second' },
    ])
    const { engine } = makeEngine({ scopes, adapter })
    await engine.authorize(subject, 'admin.posts.update', { resource: () => resource })
  })

  test('all scopes fail → ScopeDeniedError naming the first scope', async () => {
    const scopes = new Map([
      ['first', new Scope('first', 'First', () => false)],
      ['second', new Scope('second', 'Second', () => false)],
    ])
    const adapter = multiGrantAdapter([
      { name: 'admin.posts.update', scope: 'first' },
      { name: 'admin.posts.update', scope: 'second' },
    ])
    const { engine } = makeEngine({ scopes, adapter })
    const err = await engine
      .authorize(subject, 'admin.posts.update', { resource: () => resource })
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(ScopeDeniedError)
    expect((err as ScopeDeniedError).scope).toBe('first')
  })

  test('an unknown scope name alongside a passing scope contributes deny, not a crash or bypass', async () => {
    const scopes = new Map([['known', new Scope('known', 'Known', () => true)]])
    const adapter = multiGrantAdapter([
      { name: 'admin.posts.update', scope: 'mystery' },
      { name: 'admin.posts.update', scope: 'known' },
    ])
    const { engine } = makeEngine({ scopes, adapter })
    await engine.authorize(subject, 'admin.posts.update', { resource: () => resource })
  })

  test('a passing scope short-circuits: later scopes are not evaluated', async () => {
    let secondRan = false
    const scopes = new Map([
      ['first', new Scope('first', 'First', () => true)],
      [
        'second',
        new Scope('second', 'Second', () => {
          secondRan = true
          return true
        }),
      ],
    ])
    const adapter = multiGrantAdapter([
      { name: 'admin.posts.update', scope: 'first' },
      { name: 'admin.posts.update', scope: 'second' },
    ])
    const { engine } = makeEngine({ scopes, adapter })
    await engine.authorize(subject, 'admin.posts.update', { resource: () => resource })
    expect(secondRan).toBe(false)
  })
})

describe('authorize() inAuthz suppression', () => {
  const subject: Subject = { id: 'u1', domain: 'admin' }
  const resource: ResourceRef = { type: 'post', id: 'p1' }

  test('set while the resolver and scope checks run, restored after allow', async () => {
    const observed: Record<string, boolean> = {}
    let engineRef: RbacEngine
    const scopes = new Map([
      [
        'probe',
        new Scope('probe', 'Probe', () => {
          observed.scopeCheck = engineRef.store.isInAuthz()
          return true
        }),
      ],
    ])
    const { adapter, engine } = makeEngine({ scopes })
    engineRef = engine
    await grant(adapter, { subjectId: 'u1', domain: 'admin', tenantId: '' }, 'admin.posts.update', 'probe')

    await engine.runWithRequestContext(async () => {
      expect(engine.store.isInAuthz()).toBe(false)
      await engine.authorize(subject, 'admin.posts.update', {
        resource: () => {
          observed.resolver = engine.store.isInAuthz()
          return resource
        },
      })
      expect(engine.store.isInAuthz()).toBe(false)
    })

    expect(observed).toEqual({ resolver: true, scopeCheck: true })
  })

  test('restored even when the scope check denies (throwing path)', async () => {
    const scopes = new Map([['closed', new Scope('closed', 'Closed', () => false)]])
    const { adapter, engine } = makeEngine({ scopes })
    await grant(adapter, { subjectId: 'u1', domain: 'admin', tenantId: '' }, 'admin.posts.update', 'closed')

    await engine.runWithRequestContext(async () => {
      const err = await engine
        .authorize(subject, 'admin.posts.update', { resource: () => resource })
        .then(
          () => null,
          (e: unknown) => e,
        )
      expect(err).toBeInstanceOf(ScopeDeniedError)
      expect(engine.store.isInAuthz()).toBe(false)
    })
  })

  test('restored when the resource resolver finds nothing (404 path)', async () => {
    const scopes = new Map([['closed', new Scope('closed', 'Closed', () => false)]])
    const { adapter, engine } = makeEngine({ scopes })
    await grant(adapter, { subjectId: 'u1', domain: 'admin', tenantId: '' }, 'admin.posts.update', 'closed')

    await engine.runWithRequestContext(async () => {
      const err = await engine
        .authorize(subject, 'admin.posts.update', { resource: () => null })
        .then(
          () => null,
          (e: unknown) => e,
        )
      expect(err).toBeInstanceOf(ResourceNotFoundError)
      expect(engine.store.isInAuthz()).toBe(false)
    })
  })
})

describe('assignPolicy scope validation', () => {
  const ref: SubjectRef = { subjectId: 'u1', domain: 'admin', tenantId: '' }

  async function sync(adapter: StorageAdapter, scopeOptions: string[]): Promise<void> {
    await adapter.upsertPolicies([
      {
        name: 'admin.posts.update',
        domain: 'admin',
        label: 'Update',
        scopeOptions,
        dependsOn: [],
      },
    ])
  }

  test('a scope outside the policy scopeOptions → UnknownScopeError, nothing assigned', async () => {
    const { adapter, engine } = makeEngine()
    await sync(adapter, ['owned'])
    const err = await engine.assignPolicy(ref, 'admin.posts.update', 'mystery').then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(UnknownScopeError)
    expect((err as Error).name).toBe('UnknownScopeError')
    expect((err as Error).message).toContain('mystery')
    expect((err as Error).message).toContain('admin.posts.update')
    expect(await adapter.getSubjectPolicies(ref)).toEqual([])
  })

  test('a declared scope is accepted', async () => {
    const { adapter, engine } = makeEngine()
    await sync(adapter, ['owned'])
    await engine.assignPolicy(ref, 'admin.posts.update', 'owned')
    expect(await adapter.getSubjectPolicies(ref)).toEqual([
      { name: 'admin.posts.update', scope: 'owned' },
    ])
  })

  test('null and omitted scopes skip validation even with empty scopeOptions', async () => {
    const { adapter, engine } = makeEngine()
    await sync(adapter, [])
    await engine.assignPolicy(ref, 'admin.posts.update', null)
    await engine.assignPolicy(ref, 'admin.posts.update')
    expect(await adapter.getSubjectPolicies(ref)).toEqual([
      { name: 'admin.posts.update', scope: null },
    ])
  })

  test('an unsynced policy with a scope still surfaces UnknownPolicyError from the adapter', async () => {
    const { engine } = makeEngine()
    const err = await engine.assignPolicy(ref, 'ghost.update', 'owned').then(
      () => null,
      (e: unknown) => e,
    )
    expect((err as Error).name).toBe('UnknownPolicyError')
  })
})
