import { describe, test, expect, spyOn, afterEach } from 'bun:test'
import { KyroguardEngine } from '../../src/core/engine.js'
import { Scope } from '../../src/core/scope.js'
import { UnauthenticatedError } from '../../src/core/errors.js'
import { inProcessBus } from '../../src/cache/bus.js'
import { memoryAdapter } from '../../src/testing/index.js'
import type { EngineOptions } from '../../src/core/engine.js'
import type { ResourceDefinition } from '../../src/core/policy.js'
import type { ScopeFilterContext } from '../../src/core/scope.js'
import type { Subject, SubjectRef } from '../../src/core/types.js'
import type { PolicyGrant, StorageAdapter } from '../../src/storage/contract.js'

const saleResource: ResourceDefinition = { type: 'sale', policies: [] }
const subject: Subject = { id: 'u1', domain: 'admin' }
const ref: SubjectRef = { subjectId: 'u1', domain: 'admin', tenantId: '' }

/** memoryAdapter guaranteed to carry NO listFilters, whatever the adapter grows later. */
function bareAdapter(): StorageAdapter {
  return { ...memoryAdapter(), listFilters: undefined }
}

function makeEngine(overrides?: Partial<EngineOptions>): { adapter: StorageAdapter; engine: KyroguardEngine } {
  const adapter = overrides?.adapter ?? bareAdapter()
  const engine = new KyroguardEngine({
    adapter,
    scopes: new Map(),
    cache: null,
    bus: inProcessBus(),
    ...overrides,
  })
  return { adapter, engine }
}

async function grant(
  adapter: StorageAdapter,
  policy: string,
  scope: string | null = null,
): Promise<void> {
  await adapter.upsertPolicies([
    { name: policy, domain: ref.domain, label: policy, scopeOptions: scope ? [scope] : [], dependsOn: [] },
  ])
  await adapter.assignPolicy(ref, policy, scope)
}

function multiGrantAdapter(grants: PolicyGrant[]): StorageAdapter {
  return { ...bareAdapter(), getSubjectPolicies: async () => grants }
}

describe('filterFor() decision procedure', () => {
  test('no subject → UnauthenticatedError (the ONLY throwing case)', async () => {
    const { engine } = makeEngine()
    expect(engine.filterFor(null, 'admin.sales.view', saleResource)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    )
    expect(engine.filterFor({ id: '' }, 'admin.sales.view', saleResource)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    )
  })

  test('super subject → all', async () => {
    const { engine } = makeEngine()
    expect(await engine.filterFor({ id: 'root', is_super: true }, 'admin.sales.view', saleResource)).toEqual({
      kind: 'all',
    })
  })

  test('superBypass false: is_super does not shortcut, no grant → none/no-policy', async () => {
    const { engine } = makeEngine({ superBypass: false })
    expect(await engine.filterFor({ id: 'root', is_super: true }, 'admin.sales.view', saleResource)).toEqual({
      kind: 'none',
      reason: 'no-policy',
    })
  })

  test('policy not granted → none/no-policy, never a throw', async () => {
    const { engine } = makeEngine()
    expect(await engine.filterFor(subject, 'admin.sales.view', saleResource)).toEqual({
      kind: 'none',
      reason: 'no-policy',
    })
  })

  test('unscoped grant → all', async () => {
    const { adapter, engine } = makeEngine()
    await grant(adapter, 'admin.sales.view')
    expect(await engine.filterFor(subject, 'admin.sales.view', saleResource)).toEqual({ kind: 'all' })
  })

  test('condition scope without a filter half folds through check(subject, null, ctx): true → all', async () => {
    let seenResource: unknown = 'unset'
    const scopes = new Map([
      [
        'business-hours',
        new Scope('business-hours', 'Business hours', (_s, resource) => {
          seenResource = resource
          return true
        }),
      ],
    ])
    const { adapter, engine } = makeEngine({ scopes })
    await grant(adapter, 'admin.sales.view', 'business-hours')
    expect(await engine.filterFor(subject, 'admin.sales.view', saleResource)).toEqual({ kind: 'all' })
    expect(seenResource).toBeNull()
  })

  test('condition scope check false → none/scope-denied', async () => {
    const scopes = new Map([['after-hours', new Scope('after-hours', 'After hours', () => false)]])
    const { adapter, engine } = makeEngine({ scopes })
    await grant(adapter, 'admin.sales.view', 'after-hours')
    expect(await engine.filterFor(subject, 'admin.sales.view', saleResource)).toEqual({
      kind: 'none',
      reason: 'scope-denied',
    })
  })

  test('Scope.owned() on an adapter without listFilters fails closed → none/scope-denied', async () => {
    const owned = Scope.owned()
    const scopes = new Map([[owned.name, owned]])
    const { adapter, engine } = makeEngine({ scopes })
    await grant(adapter, 'admin.sales.view', 'owned')
    expect(await engine.filterFor(subject, 'admin.sales.view', saleResource)).toEqual({
      kind: 'none',
      reason: 'scope-denied',
    })
  })

  test('a filter returning { where } → kind where carrying the fragment untouched', async () => {
    const fragment = { column: 'cashier_id', equals: 'u1' }
    const scopes = new Map([
      ['mine', new Scope('mine', 'Mine', () => false, () => ({ where: fragment }))],
    ])
    const { adapter, engine } = makeEngine({ scopes })
    await grant(adapter, 'admin.sales.view', 'mine')
    const result = await engine.filterFor(subject, 'admin.sales.view', saleResource)
    expect(result).toEqual({ kind: 'where', where: fragment })
  })

  test('the filter half receives (subject, { db, adapter, resource })', async () => {
    const db = { tag: 'the-db-handle' }
    let seen: { subject: Subject; ctx: ScopeFilterContext } | null = null
    const scopes = new Map([
      [
        'mine',
        new Scope('mine', 'Mine', () => false, (s, ctx) => {
          seen = { subject: s, ctx }
          return { where: 'w' }
        }),
      ],
    ])
    const { adapter, engine } = makeEngine({ scopes, db })
    await grant(adapter, 'admin.sales.view', 'mine')
    await engine.filterFor(subject, 'admin.sales.view', saleResource)

    expect(seen).not.toBeNull()
    const captured = seen! as { subject: Subject; ctx: ScopeFilterContext }
    expect(captured.subject).toBe(subject)
    expect(captured.ctx.db).toBe(db)
    expect(captured.ctx.adapter).toBe(adapter)
    expect(captured.ctx.resource).toBe(saleResource)
  })

  test('OR fold: a scope returning true short-circuits to all even when another yields a fragment', async () => {
    const scopes = new Map([
      ['fragment', new Scope('fragment', 'Fragment', () => false, () => ({ where: 'w' }))],
      ['open', new Scope('open', 'Open', () => true)],
    ])
    const adapter = multiGrantAdapter([
      { name: 'admin.sales.view', scope: 'fragment' },
      { name: 'admin.sales.view', scope: 'open' },
    ])
    const { engine } = makeEngine({ scopes, adapter })
    expect(await engine.filterFor(subject, 'admin.sales.view', saleResource)).toEqual({ kind: 'all' })
  })

  test('OR fold: false branches drop out, the single surviving fragment is returned', async () => {
    const scopes = new Map([
      ['closed', new Scope('closed', 'Closed', () => false)],
      ['mine', new Scope('mine', 'Mine', () => false, () => ({ where: 'mine-rows' }))],
    ])
    const adapter = multiGrantAdapter([
      { name: 'admin.sales.view', scope: 'closed' },
      { name: 'admin.sales.view', scope: 'mine' },
    ])
    const { engine } = makeEngine({ scopes, adapter })
    expect(await engine.filterFor(subject, 'admin.sales.view', saleResource)).toEqual({
      kind: 'where',
      where: 'mine-rows',
    })
  })

  test('two fragments on an adapter without listFilters → none/unfilterable', async () => {
    const scopes = new Map([
      ['a', new Scope('a', 'A', () => false, () => ({ where: 'a-rows' }))],
      ['b', new Scope('b', 'B', () => false, () => ({ where: 'b-rows' }))],
    ])
    const adapter = multiGrantAdapter([
      { name: 'admin.sales.view', scope: 'a' },
      { name: 'admin.sales.view', scope: 'b' },
    ])
    const { engine } = makeEngine({ scopes, adapter })
    expect(await engine.filterFor(subject, 'admin.sales.view', saleResource)).toEqual({
      kind: 'none',
      reason: 'unfilterable',
    })
  })

  test('unknown scope name contributes deny → none/scope-denied', async () => {
    const { adapter, engine } = makeEngine()
    await grant(adapter, 'admin.sales.view', 'mystery')
    expect(await engine.filterFor(subject, 'admin.sales.view', saleResource)).toEqual({
      kind: 'none',
      reason: 'scope-denied',
    })
  })
})

describe('storeFilterFor() — the guard-path entry', () => {
  test('activates the computed filter under the resource type and returns it', async () => {
    const { adapter, engine } = makeEngine()
    await grant(adapter, 'admin.sales.view')

    await engine.runWithRequestContext(async () => {
      const filter = await engine.storeFilterFor(subject, 'admin.sales.view', saleResource)
      expect(filter).toEqual({ kind: 'all' })
      expect(engine.store.getActiveFilter('sale')).toEqual({ kind: 'all' })
    })
  })

  test('the stored plan follows the policy the request exercises — same table, per request', async () => {
    const scopes = new Map([
      ['mine', new Scope('mine', 'Mine', () => false, () => ({ where: 'mine-rows' }))],
    ])
    const adapter = multiGrantAdapter([
      { name: 'admin.sales.view', scope: null },
      { name: 'admin.sales.void', scope: 'mine' },
    ])
    const { engine } = makeEngine({ scopes, adapter })

    await engine.runWithRequestContext(async () => {
      await engine.storeFilterFor(subject, 'admin.sales.view', saleResource)
      expect(engine.store.getActiveFilter('sale')).toEqual({ kind: 'all' })
    })
    await engine.runWithRequestContext(async () => {
      await engine.storeFilterFor(subject, 'admin.sales.void', saleResource)
      expect(engine.store.getActiveFilter('sale')).toEqual({ kind: 'where', where: 'mine-rows' })
    })
  })

  test('a later guard in the same request replaces the stored plan for the type', async () => {
    const scopes = new Map([
      ['mine', new Scope('mine', 'Mine', () => false, () => ({ where: 'mine-rows' }))],
    ])
    const adapter = multiGrantAdapter([
      { name: 'admin.sales.view', scope: null },
      { name: 'admin.sales.void', scope: 'mine' },
    ])
    const { engine } = makeEngine({ scopes, adapter })

    await engine.runWithRequestContext(async () => {
      await engine.storeFilterFor(subject, 'admin.sales.view', saleResource)
      await engine.storeFilterFor(subject, 'admin.sales.void', saleResource)
      expect(engine.store.getActiveFilter('sale')).toEqual({ kind: 'where', where: 'mine-rows' })
    })
  })

  test('no grant stores none/no-policy — the wrapper fails closed, never open', async () => {
    const { engine } = makeEngine()
    await engine.runWithRequestContext(async () => {
      await engine.storeFilterFor(subject, 'admin.sales.view', saleResource)
      expect(engine.store.getActiveFilter('sale')).toEqual({ kind: 'none', reason: 'no-policy' })
    })
  })

  test('outside a request context it still computes and returns, storing nowhere', async () => {
    const { adapter, engine } = makeEngine()
    await grant(adapter, 'admin.sales.view')
    expect(await engine.storeFilterFor(subject, 'admin.sales.view', saleResource)).toEqual({
      kind: 'all',
    })
    expect(engine.store.getActiveFilter('sale')).toBeUndefined()
  })

  test('no subject → UnauthenticatedError, nothing stored', async () => {
    const { engine } = makeEngine()
    await engine.runWithRequestContext(async () => {
      await expect(
        engine.storeFilterFor(null, 'admin.sales.view', saleResource),
      ).rejects.toBeInstanceOf(UnauthenticatedError)
      expect(engine.store.getActiveFilter('sale')).toBeUndefined()
    })
  })

  test('a domainless subject resolves the unqualified policy name', async () => {
    const bareRef: SubjectRef = { subjectId: 'u2', domain: '', tenantId: '' }
    const { adapter, engine } = makeEngine()
    await adapter.upsertPolicies([
      { name: 'sales.view', domain: '', label: 'View', scopeOptions: [], dependsOn: [] },
    ])
    await adapter.assignPolicy(bareRef, 'sales.view', null)
    await engine.runWithRequestContext(async () => {
      await engine.storeFilterFor({ id: 'u2' }, 'sales.view', saleResource)
      expect(engine.store.getActiveFilter('sale')).toEqual({ kind: 'all' })
    })
  })
})

describe('inAuthz suppression flag', () => {
  test('set while filterFor builds filters, restored after (both outcomes observed in-context)', async () => {
    const observed: boolean[] = []
    let engineRef: KyroguardEngine
    const scopes = new Map([
      [
        'mine',
        new Scope('mine', 'Mine', () => false, () => {
          observed.push(engineRef.store.isInAuthz())
          return { where: 'w' }
        }),
      ],
    ])
    const { adapter, engine } = makeEngine({ scopes })
    engineRef = engine
    await grant(adapter, 'admin.sales.view', 'mine')

    await engine.runWithRequestContext(async () => {
      expect(engine.store.isInAuthz()).toBe(false)
      await engine.filterFor(subject, 'admin.sales.view', saleResource)
      expect(engine.store.isInAuthz()).toBe(false)
    })

    expect(observed).toEqual([true])
  })

  test('condition scopes folded through check() on the list path also run suppressed', async () => {
    const observed: boolean[] = []
    let engineRef: KyroguardEngine
    const scopes = new Map([
      [
        'open',
        new Scope('open', 'Open', () => {
          observed.push(engineRef.store.isInAuthz())
          return true
        }),
      ],
    ])
    const { adapter, engine } = makeEngine({ scopes })
    engineRef = engine
    await grant(adapter, 'admin.sales.view', 'open')

    await engine.runWithRequestContext(async () => {
      await engine.filterFor(subject, 'admin.sales.view', saleResource)
      expect(engine.store.isInAuthz()).toBe(false)
    })

    expect(observed).toEqual([true])
  })

  test('outside any request context isInAuthz() is false and filterFor still works', async () => {
    const { adapter, engine } = makeEngine()
    await grant(adapter, 'admin.sales.view')
    expect(engine.store.isInAuthz()).toBe(false)
    expect(await engine.filterFor(subject, 'admin.sales.view', saleResource)).toEqual({ kind: 'all' })
    expect(engine.store.isInAuthz()).toBe(false)
  })
})

describe('filterFor() one-time warnings', () => {
  let warn: ReturnType<typeof spyOn> | null = null

  afterEach(() => {
    warn?.mockRestore()
    warn = null
  })

  test('unknown scope warns once per name across repeated calls', async () => {
    warn = spyOn(console, 'warn').mockImplementation(() => {})
    const { adapter, engine } = makeEngine()
    await grant(adapter, 'admin.sales.view', 'mystery')

    await engine.filterFor(subject, 'admin.sales.view', saleResource)
    await engine.filterFor(subject, 'admin.sales.view', saleResource)

    const mysteryWarnings = warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('mystery'))
    expect(mysteryWarnings).toHaveLength(1)
  })

  test('unfilterable warns once per adapter across repeated calls', async () => {
    warn = spyOn(console, 'warn').mockImplementation(() => {})
    const scopes = new Map([
      ['a', new Scope('a', 'A', () => false, () => ({ where: 'a-rows' }))],
      ['b', new Scope('b', 'B', () => false, () => ({ where: 'b-rows' }))],
    ])
    const adapter = multiGrantAdapter([
      { name: 'admin.sales.view', scope: 'a' },
      { name: 'admin.sales.view', scope: 'b' },
    ])
    const { engine } = makeEngine({ scopes, adapter })

    await engine.filterFor(subject, 'admin.sales.view', saleResource)
    await engine.filterFor(subject, 'admin.sales.view', saleResource)

    const unfilterableWarnings = warn.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('listFilters'),
    )
    expect(unfilterableWarnings).toHaveLength(1)
  })
})

describe('filterFor() decision events', () => {
  test("events carry mode 'list'; authorize events carry mode 'guard'", async () => {
    const events: Parameters<NonNullable<EngineOptions['onDecision']>>[0][] = []
    const { adapter, engine } = makeEngine({ onDecision: event => events.push(event) })
    await grant(adapter, 'admin.sales.view')

    await engine.filterFor(subject, 'admin.sales.view', saleResource)
    await engine.authorize(subject, 'admin.sales.view')

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ mode: 'list', decision: 'allow', reason: 'granted' })
    expect(events[1]).toMatchObject({ mode: 'guard', decision: 'allow', reason: 'granted' })
  })
})
