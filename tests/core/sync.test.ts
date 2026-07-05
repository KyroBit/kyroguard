import { describe, test, expect } from 'bun:test'
import { syncPolicies } from '../../src/core/sync.js'
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
  test('first sync inserts qualified policies with the portal column set', async () => {
    const adapter = memoryAdapter()
    await syncPolicies(
      adapter,
      resources(new Policy('posts.read'), new Policy('posts.write', 'Write posts', ['posts.read'])),
      'admin',
    )

    const records = await adapter.listPolicies()
    expect(records.map(r => r.name).sort()).toEqual(['admin.posts.read', 'admin.posts.write'])
    for (const record of records) expect(record.portal).toBe('admin')

    const write = records.find(r => r.name === 'admin.posts.write')!
    expect(write.dependsOn).toEqual(['admin.posts.read'])
  })

  test("portal-less sync ('' sentinel) leaves names unqualified", async () => {
    const adapter = memoryAdapter()
    await syncPolicies(adapter, resources(new Policy('posts.read')))
    const records = await adapter.listPolicies()
    expect(records).toHaveLength(1)
    expect(records[0]!.name).toBe('posts.read')
    expect(records[0]!.portal).toBe('')
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

  test("orphan cleanup removes only THIS portal's orphans (S19) and cascades assignments (S6)", async () => {
    const adapter = memoryAdapter()

    // Seed two portals.
    await syncPolicies(
      adapter,
      resources(new Policy('posts.read'), new Policy('posts.write')),
      'admin',
    )
    await syncPolicies(adapter, resources(new Policy('reports.view')), 'branch')

    // Hang assignments off the soon-to-be orphan admin.posts.write.
    const ref: SubjectRef = { subjectId: 'u1', portal: 'admin', contextId: '' }
    await adapter.assignPolicy(ref, 'admin.posts.write', null)
    await adapter.upsertGroup({ name: 'editors', label: 'Editors' })
    await adapter.setGroupPolicies('editors', [{ policyName: 'admin.posts.write', scope: null }])

    // Re-sync admin WITHOUT posts.write: it is now an orphan of the admin portal.
    await syncPolicies(adapter, resources(new Policy('posts.read')), 'admin')

    // Only the admin orphan is gone — the branch portal is untouched (S19).
    expect(await namesFor(adapter)).toEqual(['admin.posts.read', 'branch.reports.view'])

    // Cascade (S6): direct assignment and group entry for the orphan are gone.
    expect(await adapter.getSubjectPolicies(ref)).toEqual([])
    expect(await adapter.getGroupPolicies('editors')).toEqual([])
  })

  test('deleting every policy of one portal never touches the other portal', async () => {
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
    // Additive: the existing entry keeps its scope; filled deps are unrestricted.
    expect(byName.get('admin.posts.publish')).toBe('owned')
    expect(byName.get('admin.posts.write')).toBeNull()
    expect(byName.get('admin.posts.read')).toBeNull()
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

  test('empty resources list is a no-op — it never wipes a portal', async () => {
    const adapter = memoryAdapter()
    await syncPolicies(adapter, resources(new Policy('posts.read')), 'admin')

    await syncPolicies(adapter, [], 'admin')
    await syncPolicies(adapter, [{ policies: [] }], 'admin')

    expect(await namesFor(adapter)).toEqual(['admin.posts.read'])
  })
})
