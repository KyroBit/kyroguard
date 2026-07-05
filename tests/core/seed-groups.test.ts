import { describe, test, expect } from 'bun:test'
import { seedGroups } from '../../src/core/seed-groups.js'
import { Policy } from '../../src/core/policy.js'
import { Scope } from '../../src/core/scope.js'
import { memoryAdapter } from '../../src/testing/index.js'
import type { StorageAdapter } from '../../src/storage/contract.js'

async function entriesOf(
  adapter: StorageAdapter,
  group: string,
): Promise<{ policyName: string; scope: string | null }[]> {
  const entries = await adapter.getGroupPolicies(group)
  return [...entries].sort((a, b) => (a.policyName < b.policyName ? -1 : 1))
}

describe('seedGroups formats', () => {
  test("array format: every listed policy unrestricted (scope null)", async () => {
    const adapter = memoryAdapter()
    await seedGroups(
      adapter,
      { editors: { label: 'Editors', policies: ['posts.read', 'posts.write'] } },
      undefined,
      'admin',
    )
    expect(await entriesOf(adapter, 'editors')).toEqual([
      { policyName: 'admin.posts.read', scope: null },
      { policyName: 'admin.posts.write', scope: null },
    ])
  })

  test('record format: policy → scope, null meaning unrestricted', async () => {
    const adapter = memoryAdapter()
    await seedGroups(
      adapter,
      {
        authors: {
          label: 'Authors',
          policies: { 'posts.read': null, 'posts.update': 'owned' },
        },
      },
      undefined,
      'admin',
    )
    expect(await entriesOf(adapter, 'authors')).toEqual([
      { policyName: 'admin.posts.read', scope: null },
      { policyName: 'admin.posts.update', scope: 'owned' },
    ])
  })

  test("'all' format: every synced policy, unrestricted", async () => {
    const adapter = memoryAdapter()
    await seedGroups(
      adapter,
      { admins: { label: 'Admins', policies: 'all' } },
      [{ name: 'posts.read' }, { name: 'posts.write' }],
      'admin',
    )
    expect(await entriesOf(adapter, 'admins')).toEqual([
      { policyName: 'admin.posts.read', scope: null },
      { policyName: 'admin.posts.write', scope: null },
    ])
  })

  test("'all' without an allPolicies array throws (names the group)", async () => {
    const adapter = memoryAdapter()
    expect(
      seedGroups(adapter, { admins: { label: 'Admins', policies: 'all' } }),
    ).rejects.toThrow(/group "admins" uses policies: 'all'/)
  })
})

describe('seedGroups scope validation', () => {
  const owned = Scope.owned()

  test('record-form scope not in the policy scopeOptions throws naming group, policy and scope', async () => {
    const adapter = memoryAdapter()
    const allPolicies = [new Policy('posts.update', { scopeOptions: [owned] })]
    await expect(
      seedGroups(
        adapter,
        { authors: { label: 'Authors', policies: { 'posts.update': 'mystery' } } },
        allPolicies,
        'admin',
      ),
    ).rejects.toThrow(/group "authors".*policy "posts\.update".*scope "mystery"/)
    expect(await adapter.listGroups()).toEqual([])
  })

  test('a declared scope passes and is stored', async () => {
    const adapter = memoryAdapter()
    const allPolicies = [new Policy('posts.update', { scopeOptions: [owned] })]
    await seedGroups(
      adapter,
      { authors: { label: 'Authors', policies: { 'posts.update': 'owned' } } },
      allPolicies,
      'admin',
    )
    expect(await entriesOf(adapter, 'authors')).toEqual([
      { policyName: 'admin.posts.update', scope: 'owned' },
    ])
  })

  test('a policy declaring no scopeOptions rejects any named scope', async () => {
    const adapter = memoryAdapter()
    await expect(
      seedGroups(
        adapter,
        { authors: { label: 'Authors', policies: { 'posts.update': 'owned' } } },
        [new Policy('posts.update')],
        'admin',
      ),
    ).rejects.toThrow(/\(none\)/)
  })

  test('name-only allPolicies entries carry no scopeOptions — validation is skipped', async () => {
    const adapter = memoryAdapter()
    await seedGroups(
      adapter,
      { authors: { label: 'Authors', policies: { 'posts.update': 'anything' } } },
      [{ name: 'posts.update' }],
      'admin',
    )
    expect(await entriesOf(adapter, 'authors')).toEqual([
      { policyName: 'admin.posts.update', scope: 'anything' },
    ])
  })

  test('null scopes are never validated', async () => {
    const adapter = memoryAdapter()
    await seedGroups(
      adapter,
      { viewers: { label: 'Viewers', policies: { 'posts.read': null } } },
      [new Policy('posts.read')],
      'admin',
    )
    expect(await entriesOf(adapter, 'viewers')).toEqual([
      { policyName: 'admin.posts.read', scope: null },
    ])
  })
})

describe('seedGroups semantics', () => {
  test('replace-all: re-seeding removes stale entries — but only for that group', async () => {
    const adapter = memoryAdapter()
    await seedGroups(
      adapter,
      {
        editors: { label: 'Editors', policies: ['posts.read', 'posts.write'] },
        viewers: { label: 'Viewers', policies: ['posts.read'] },
      },
      undefined,
      'admin',
    )

    // Re-seed only editors, dropping posts.write and adding posts.publish.
    await seedGroups(
      adapter,
      { editors: { label: 'Editors', policies: ['posts.read', 'posts.publish'] } },
      undefined,
      'admin',
    )

    expect(await entriesOf(adapter, 'editors')).toEqual([
      { policyName: 'admin.posts.publish', scope: null },
      { policyName: 'admin.posts.read', scope: null },
    ])
    // The other group is untouched.
    expect(await entriesOf(adapter, 'viewers')).toEqual([
      { policyName: 'admin.posts.read', scope: null },
    ])
  })

  test('domain qualification: domain prefixes names, no domain leaves them bare', async () => {
    const adapter = memoryAdapter()
    await seedGroups(adapter, { a: { label: 'A', policies: ['posts.read'] } }, undefined, 'branch')
    await seedGroups(adapter, { b: { label: 'B', policies: ['posts.read'] } })

    expect(await entriesOf(adapter, 'a')).toEqual([
      { policyName: 'branch.posts.read', scope: null },
    ])
    expect(await entriesOf(adapter, 'b')).toEqual([{ policyName: 'posts.read', scope: null }])
  })

  test('re-seed is idempotent: same input twice yields the same single set of entries', async () => {
    const adapter = memoryAdapter()
    const groups = {
      editors: {
        label: 'Editors',
        description: 'Can edit posts',
        policies: { 'posts.read': null, 'posts.update': 'owned' },
      },
    }
    await seedGroups(adapter, groups, undefined, 'admin')
    await seedGroups(adapter, groups, undefined, 'admin')

    expect(await entriesOf(adapter, 'editors')).toEqual([
      { policyName: 'admin.posts.read', scope: null },
      { policyName: 'admin.posts.update', scope: 'owned' },
    ])
    // Still exactly one group with its metadata intact.
    const listed = await adapter.listGroups()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ name: 'editors', label: 'Editors', isSystem: false })
  })
})
