import { describe, test, expect } from 'bun:test'
import { backfillGroupDependencies, syncPolicies } from '../../src/core/sync.js'
import { Policy } from '../../src/core/policy.js'
import { memoryAdapter } from '../../src/testing/index.js'
import type { SubjectRef } from '../../src/core/types.js'
import type { StorageAdapter } from '../../src/storage/contract.js'

const resources = (...policies: Policy[]) => [{ policies }]

async function namesFor(adapter: StorageAdapter): Promise<string[]> {
  const records = await adapter.listPolicies()
  return records.map(record => record.name).sort()
}

describe('syncPolicies', () => {
  test('first sync inserts qualified policies with the domain column set', async () => {
    const adapter = memoryAdapter()
    await syncPolicies(
      adapter,
      resources(new Policy('posts.read'), new Policy('posts.write', 'Write posts', ['posts.read'])),
      'admin',
    )

    const records = await adapter.listPolicies()
    expect(records.map(r => r.name).sort()).toEqual(['admin.posts.read', 'admin.posts.write'])
    for (const record of records) expect(record.domain).toBe('admin')

    const write = records.find(r => r.name === 'admin.posts.write')!
    expect(write.dependsOn).toEqual(['admin.posts.read'])
  })

  test("sync with no domain ('' sentinel) leaves names unqualified", async () => {
    const adapter = memoryAdapter()
    await syncPolicies(adapter, resources(new Policy('posts.read')))
    const records = await adapter.listPolicies()
    expect(records).toHaveLength(1)
    expect(records[0]!.name).toBe('posts.read')
    expect(records[0]!.domain).toBe('')
  })

  test('re-sync with changed label/dependsOn updates metadata in place (S5/S15) — same id, new deps', async () => {
    const adapter = memoryAdapter()
    await syncPolicies(
      adapter,
      resources(new Policy('posts.read'), new Policy('posts.write', 'Write')),
      'admin',
    )
    const before = await adapter.listPolicies()
    const writeBefore = before.find(r => r.name === 'admin.posts.write')!
    expect(writeBefore.dependsOn).toEqual([])

    // Same policies, new label and a new dependency.
    await syncPolicies(
      adapter,
      resources(new Policy('posts.read'), new Policy('posts.write', 'Write v2', ['posts.read'])),
      'admin',
    )
    const after = await adapter.listPolicies()
    expect(after).toHaveLength(2)
    const writeAfter = after.find(r => r.name === 'admin.posts.write')!
    // Updated in place, not delete+insert: the row id is stable.
    expect(writeAfter.id).toBe(writeBefore.id)
    expect(writeAfter.dependsOn).toEqual(['admin.posts.read'])
  })

  test("orphan cleanup removes only THIS domain's orphans (S19) and cascades assignments (S6)", async () => {
    const adapter = memoryAdapter()

    // Seed two domains.
    await syncPolicies(
      adapter,
      resources(new Policy('posts.read'), new Policy('posts.write')),
      'admin',
    )
    await syncPolicies(adapter, resources(new Policy('reports.view')), 'branch')

    // Hang assignments off the soon-to-be orphan admin.posts.write.
    const ref: SubjectRef = { subjectId: 'u1', domain: 'admin', tenantId: '' }
    await adapter.assignPolicy(ref, 'admin.posts.write', null)
    await adapter.upsertGroup({ name: 'editors', label: 'Editors' })
    await adapter.setGroupPolicies('editors', [{ policyName: 'admin.posts.write', scope: null }])

    // Re-sync admin WITHOUT posts.write: it is now an orphan of the admin domain.
    await syncPolicies(adapter, resources(new Policy('posts.read')), 'admin')

    // Only the admin orphan is gone — the branch domain is untouched (S19).
    expect(await namesFor(adapter)).toEqual(['admin.posts.read', 'branch.reports.view'])

    // Cascade (S6): direct assignment and group entry for the orphan are gone.
    expect(await adapter.getSubjectPolicies(ref)).toEqual([])
    expect(await adapter.getGroupPolicies('editors')).toEqual([])
  })

  test('deleting every policy of one domain never touches the other domain', async () => {
    const adapter = memoryAdapter()
    await syncPolicies(adapter, resources(new Policy('a'), new Policy('b')), 'admin')
    await syncPolicies(adapter, resources(new Policy('c')), 'branch')

    // Admin now only defines a brand-new policy: a and b become orphans.
    await syncPolicies(adapter, resources(new Policy('z')), 'admin')
    expect(await namesFor(adapter)).toEqual(['admin.z', 'branch.c'])
  })

  test('dependency back-fill fills missing TRANSITIVE deps into groups, additively', async () => {
    const adapter = memoryAdapter()
    const chain = resources(
      new Policy('posts.read'),
      new Policy('posts.write', undefined, ['posts.read']),
      new Policy('posts.publish', undefined, ['posts.write']),
      new Policy('posts.unrelated'),
    )
    await syncPolicies(adapter, chain, 'admin')

    // Group holds only the root of the chain, with a scope that must survive.
    await adapter.upsertGroup({ name: 'publishers', label: 'Publishers' })
    await adapter.setGroupPolicies('publishers', [
      { policyName: 'admin.posts.publish', scope: 'owned' },
    ])

    await syncPolicies(adapter, chain, 'admin')

    const entries = await adapter.getGroupPolicies('publishers')
    const byName = new Map(entries.map(entry => [entry.policyName, entry.scope]))
    expect([...byName.keys()].sort()).toEqual([
      'admin.posts.publish',
      'admin.posts.read',
      'admin.posts.write',
    ])
    // Additive: the existing entry keeps its scope; filled deps inherit the
    // scope of the grant that pulled them in (least privilege).
    expect(byName.get('admin.posts.publish')).toBe('owned')
    expect(byName.get('admin.posts.write')).toBe('owned')
    expect(byName.get('admin.posts.read')).toBe('owned')
    // Unrelated policies are never pulled in.
    expect(byName.has('admin.posts.unrelated')).toBe(false)
  })

  test('back-fill is idempotent across repeated syncs', async () => {
    const adapter = memoryAdapter()
    const defs = resources(new Policy('a'), new Policy('b', undefined, ['a']))
    await syncPolicies(adapter, defs, 'admin')
    await adapter.upsertGroup({ name: 'g', label: 'G' })
    await adapter.setGroupPolicies('g', [{ policyName: 'admin.b', scope: null }])

    await syncPolicies(adapter, defs, 'admin')
    await syncPolicies(adapter, defs, 'admin')
    const entries = await adapter.getGroupPolicies('g')
    expect(entries.map(entry => entry.policyName).sort()).toEqual(['admin.a', 'admin.b'])
  })

  test('unknown dependsOn throws before any write', async () => {
    const adapter = memoryAdapter()
    const bad = resources(new Policy('posts.read'), new Policy('posts.write', undefined, ['nope']))
    expect(syncPolicies(adapter, bad, 'admin')).rejects.toThrow(
      /depends on "nope" which is not defined/,
    )
    // Nothing was written — not even the valid policy.
    expect(await adapter.listPolicies()).toEqual([])
  })

  test('empty resources list is a no-op — it never wipes a domain', async () => {
    const adapter = memoryAdapter()
    await syncPolicies(adapter, resources(new Policy('posts.read')), 'admin')

    await syncPolicies(adapter, [], 'admin')
    await syncPolicies(adapter, [{ policies: [] }], 'admin')

    expect(await namesFor(adapter)).toEqual(['admin.posts.read'])
  })
})

describe('dependency back-fill scope inheritance (least privilege)', () => {
  const P = (name: string, deps: string[] = []) => ({
    name,
    label: name,
    dependsOn: deps,
    scopeOptions: [],
  })

  async function setup(entries: { policyName: string; scope: string | null }[]) {
    const adapter = memoryAdapter()
    const resources = [
      {
        policies: [
          P('sales.view'),
          P('sales.void', ['sales.view']),
          P('sales.update', ['sales.view']),
          P('sales.refund', ['sales.void']),
        ],
      },
    ]
    await syncPolicies(adapter, resources as never)
    await adapter.upsertGroup({ name: 'g', label: 'G' })
    await adapter.setGroupPolicies('g', entries)
    return { adapter, resources }
  }

  test('a scoped grant fills its dependency with the same scope', async () => {
    const { adapter, resources } = await setup([{ policyName: 'sales.void', scope: 'owned' }])
    await backfillGroupDependencies(adapter, resources as never)

    const entries = new Map((await adapter.getGroupPolicies('g')).map(e => [e.policyName, e.scope]))
    expect(entries.get('sales.view')).toBe('owned')
  })

  test('scope inheritance propagates down chains', async () => {
    const { adapter, resources } = await setup([{ policyName: 'sales.refund', scope: 'owned' }])
    await backfillGroupDependencies(adapter, resources as never)

    const entries = new Map((await adapter.getGroupPolicies('g')).map(e => [e.policyName, e.scope]))
    expect(entries.get('sales.void')).toBe('owned')
    expect(entries.get('sales.view')).toBe('owned')
  })

  test('an unrestricted grant widens a shared dependency to unrestricted', async () => {
    const { adapter, resources } = await setup([
      { policyName: 'sales.void', scope: 'owned' },
      { policyName: 'sales.update', scope: null },
    ])
    await backfillGroupDependencies(adapter, resources as never)

    const entries = new Map((await adapter.getGroupPolicies('g')).map(e => [e.policyName, e.scope]))
    expect(entries.get('sales.view')).toBeNull()
  })

  test('two different named scopes fall back to unrestricted with a warning', async () => {
    const { adapter, resources } = await setup([
      { policyName: 'sales.void', scope: 'owned' },
      { policyName: 'sales.update', scope: 'same-branch' },
    ])
    const logs: string[] = []
    await backfillGroupDependencies(adapter, resources as never, undefined, {
      logger: msg => logs.push(msg),
    })

    const entries = new Map((await adapter.getGroupPolicies('g')).map(e => [e.policyName, e.scope]))
    expect(entries.get('sales.view')).toBeNull()
    expect(logs.some(line => line.includes('WARNING') && line.includes('sales.view'))).toBe(true)
  })

  test('an explicit entry is never overwritten and governs its own dependencies', async () => {
    const { adapter, resources } = await setup([
      { policyName: 'sales.refund', scope: 'owned' },
      { policyName: 'sales.void', scope: null },
    ])
    await backfillGroupDependencies(adapter, resources as never)

    const entries = new Map((await adapter.getGroupPolicies('g')).map(e => [e.policyName, e.scope]))
    expect(entries.get('sales.void')).toBeNull()
    // sales.view flows from the explicit unrestricted sales.void, not from refund's 'owned'.
    expect(entries.get('sales.view')).toBeNull()
  })
})
