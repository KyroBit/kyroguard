/**
 * Executable specification of src/storage/contract.ts: every clause S1–S23
 * has at least one case named with its clause id.
 *
 * listFilters fragments are backend-native and therefore NOT portable enough
 * for this suite; the memory reference adapter's shape is `{ where: (row:
 * { id: string }) => boolean }` (with `or` folding predicates and `none` the
 * always-false predicate), which is what lets engine.filterFor be exercised
 * without a database. Backend adapters snapshot-test their fragments in their
 * own suites; check/filter parity is the caller's job via assertScopeParity.
 */

import type { SubjectRef } from '../index.js'
import type {
  GroupPolicyEntry,
  OwnershipEntry,
  PolicyDefinitionRow,
  StorageAdapter,
} from '../storage/contract.js'

export interface SuiteTestApi {
  describe: (name: string, fn: () => void) => void
  it: (name: string, fn: () => void | Promise<void>) => void
  expect: any
  beforeEach?: (fn: () => void | Promise<void>) => void
  afterAll?: (fn: () => void | Promise<void>) => void
}

export interface StorageAdapterSuiteOptions {
  name: string
  makeAdapter: () => Promise<{ adapter: StorageAdapter; cleanup?: () => Promise<void> }>
  test: SuiteTestApi
}

export function runStorageAdapterContractSuite(options: StorageAdapterSuiteOptions): void {
  const { describe, it, expect } = options.test

  const withAdapter = async (fn: (adapter: StorageAdapter) => Promise<void>): Promise<void> => {
    const { adapter, cleanup } = await options.makeAdapter()
    try {
      await fn(adapter)
    } finally {
      if (cleanup) await cleanup()
      else await adapter.close?.()
    }
  }

  const row = (name: string, over: Partial<PolicyDefinitionRow> = {}): PolicyDefinitionRow => ({
    name,
    domain: '',
    label: name,
    scopeOptions: [],
    dependsOn: [],
    ...over,
  })

  const seedPolicies = (adapter: StorageAdapter, policyNames: string[], domain = ''): Promise<void> =>
    adapter.upsertPolicies(policyNames.map(name => row(name, { domain })))

  const seedGroup = async (
    adapter: StorageAdapter,
    name: string,
    entries: GroupPolicyEntry[],
  ): Promise<void> => {
    await adapter.upsertGroup({ name, label: name })
    await adapter.setGroupPolicies(name, entries)
  }

  const ref = (subjectId: string, domain = '', tenantId = ''): SubjectRef => ({
    subjectId,
    domain,
    tenantId,
  })

  const names = (records: { name: string }[]): string[] => records.map(record => record.name)

  const sortEntries = (entries: GroupPolicyEntry[]): GroupPolicyEntry[] =>
    [...entries].sort((a, b) =>
      a.policyName < b.policyName ? -1 : a.policyName > b.policyName ? 1 : 0,
    )

  describe(`storage adapter contract: ${options.name}`, () => {
    describe('S1 — empty-string sentinels', () => {
      it("S1: a grant stored at ('','') resolves for a request at ('','')", () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['p.read'])
          await adapter.assignPolicy(ref('u1'), 'p.read')
          expect(await adapter.getSubjectPolicies(ref('u1'))).toEqual([
            { name: 'p.read', scope: null },
          ])
        }))

      it("S1: policies persist domain as the '' sentinel string, never null", () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['p.read'])
          const record = (await adapter.listPolicies()).find(policy => policy.name === 'p.read')
          expect(record?.domain).toBe('')
        }))
    })

    describe('S2 — strict tuple matching (tenant-isolation invariant)', () => {
      const matrix: {
        grant: { domain: string; tenantId: string }
        req: { domain: string; tenantId: string }
        visible: boolean
        title: string
      }[] = [
        {
          grant: { domain: 'branch', tenantId: 'b1' },
          req: { domain: 'branch', tenantId: 'b1' },
          visible: true,
          title: "grant at ('branch','b1') is returned for ('branch','b1')",
        },
        {
          grant: { domain: 'branch', tenantId: 'b1' },
          req: { domain: 'branch', tenantId: 'b2' },
          visible: false,
          title: "grant at ('branch','b1') does not match ('branch','b2')",
        },
        {
          grant: { domain: 'branch', tenantId: 'b1' },
          req: { domain: 'branch', tenantId: '' },
          visible: false,
          title: "tenant grant at ('branch','b1') does not leak into ('branch','')",
        },
        {
          grant: { domain: 'branch', tenantId: '' },
          req: { domain: 'branch', tenantId: 'b1' },
          visible: false,
          title: "domain-wide grant at ('branch','') does not fall back into ('branch','b1')",
        },
        {
          grant: { domain: '', tenantId: '' },
          req: { domain: 'branch', tenantId: '' },
          visible: false,
          title: "no-domain grant at ('','') does not leak into domain ('branch','')",
        },
        {
          grant: { domain: 'branch', tenantId: '' },
          req: { domain: '', tenantId: '' },
          visible: false,
          title: "domain grant at ('branch','') does not leak into the no-domain ('','')",
        },
        {
          grant: { domain: 'admin', tenantId: '' },
          req: { domain: 'branch', tenantId: '' },
          visible: false,
          title: "grant in domain 'admin' does not match domain 'branch'",
        },
        {
          grant: { domain: '', tenantId: 'c1' },
          req: { domain: '', tenantId: 'c2' },
          visible: false,
          title: "no-domain tenant grant at ('','c1') does not match ('','c2')",
        },
      ]

      for (const entry of matrix) {
        it(`S2: ${entry.title}`, () =>
          withAdapter(async adapter => {
            await seedPolicies(adapter, ['p.read'])
            await adapter.assignPolicy({ subjectId: 'u1', ...entry.grant }, 'p.read')
            const grants = await adapter.getSubjectPolicies({ subjectId: 'u1', ...entry.req })
            expect(names(grants)).toEqual(entry.visible ? ['p.read'] : [])
          }))
      }

      it("S2: group grant at ('branch','b1') is not returned for ('branch','b2')", () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['p.read'])
          await seedGroup(adapter, 'g', [{ policyName: 'p.read', scope: null }])
          await adapter.assignGroup(ref('u1', 'branch', 'b1'), 'g')
          expect(await adapter.getSubjectPolicies(ref('u1', 'branch', 'b2'))).toEqual([])
          expect(names(await adapter.getSubjectPolicies(ref('u1', 'branch', 'b1')))).toEqual([
            'p.read',
          ])
        }))

      it("S2: group grant at ('branch','') is not returned for ('branch','b1')", () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['p.read'])
          await seedGroup(adapter, 'g', [{ policyName: 'p.read', scope: null }])
          await adapter.assignGroup(ref('u1', 'branch'), 'g')
          expect(await adapter.getSubjectPolicies(ref('u1', 'branch', 'b1'))).toEqual([])
        }))
    })

    describe('S3 — group grants AND direct grants, both strict-matched', () => {
      it('S3: getSubjectPolicies returns group grants and direct grants together', () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['a.read', 'b.read'])
          await seedGroup(adapter, 'g', [{ policyName: 'a.read', scope: null }])
          await adapter.assignGroup(ref('u1'), 'g')
          await adapter.assignPolicy(ref('u1'), 'b.read')
          const grants = await adapter.getSubjectPolicies(ref('u1'))
          expect(names(grants).sort()).toEqual(['a.read', 'b.read'])
        }))

      it('S3: a group grant and a direct grant on different domains stay isolated', () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['a.read', 'b.read'])
          await seedGroup(adapter, 'g', [{ policyName: 'a.read', scope: null }])
          await adapter.assignGroup(ref('u1', 'admin'), 'g')
          await adapter.assignPolicy(ref('u1', 'branch'), 'b.read')
          expect(names(await adapter.getSubjectPolicies(ref('u1', 'admin')))).toEqual(['a.read'])
          expect(names(await adapter.getSubjectPolicies(ref('u1', 'branch')))).toEqual(['b.read'])
        }))

      it('S3: direct grants are tenant-scoped exactly like group grants', () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['p.read'])
          await adapter.assignPolicy(ref('u1', 'branch', 'c1'), 'p.read')
          expect(await adapter.getSubjectPolicies(ref('u1', 'branch', 'c2'))).toEqual([])
          expect(names(await adapter.getSubjectPolicies(ref('u1', 'branch', 'c1')))).toEqual([
            'p.read',
          ])
        }))
    })

    describe('S4 — every matching row, no deduplication, stable order', () => {
      it('S4: duplicate grants of one policy are all returned (scope precedence is the engine, not the adapter)', () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['p.read'])
          await seedGroup(adapter, 'g', [{ policyName: 'p.read', scope: 'owned' }])
          await adapter.assignGroup(ref('u1'), 'g')
          await adapter.assignPolicy(ref('u1'), 'p.read', null)
          const grants = await adapter.getSubjectPolicies(ref('u1'))
          expect(grants).toHaveLength(2)
          expect(names(grants)).toEqual(['p.read', 'p.read'])
        }))

      it('S4: rows come in stable order — group grants first, then direct grants, each sorted by name', () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['a.read', 'b.read', 'y.read', 'z.read'])
          await seedGroup(adapter, 'g', [
            { policyName: 'z.read', scope: null },
            { policyName: 'y.read', scope: null },
          ])
          await adapter.assignGroup(ref('u1'), 'g')
          await adapter.assignPolicy(ref('u1'), 'b.read')
          await adapter.assignPolicy(ref('u1'), 'a.read')
          const grants = await adapter.getSubjectPolicies(ref('u1'))
          expect(names(grants)).toEqual(['y.read', 'z.read', 'a.read', 'b.read'])
        }))
    })

    describe('S5 / S15 — upsertPolicies updates existing metadata', () => {
      it('S5: re-upserting a policy updates it in place — one row, stable id', () =>
        withAdapter(async adapter => {
          await adapter.upsertPolicies([row('p.read')])
          const before = (await adapter.listPolicies()).find(policy => policy.name === 'p.read')
          await adapter.upsertPolicies([row('p.read', { label: 'Read (v2)' })])
          const after = (await adapter.listPolicies()).filter(policy => policy.name === 'p.read')
          expect(after).toHaveLength(1)
          expect(after[0]?.id).toBe(before?.id)
        }))

      it('S5: upsertPolicies updates dependsOn on an existing policy', () =>
        withAdapter(async adapter => {
          await adapter.upsertPolicies([row('p.base'), row('p.read')])
          await adapter.upsertPolicies([row('p.read', { dependsOn: ['p.base'] })])
          const record = (await adapter.listPolicies()).find(policy => policy.name === 'p.read')
          expect(record?.dependsOn).toEqual(['p.base'])
        }))

      it('S15: listPolicies reflects a CHANGED dependsOn (self-referential SQL upsert regression)', () =>
        withAdapter(async adapter => {
          await adapter.upsertPolicies([
            row('p.a'),
            row('p.b'),
            row('p.read', { dependsOn: ['p.a'] }),
          ])
          await adapter.upsertPolicies([row('p.read', { dependsOn: ['p.b'] })])
          const record = (await adapter.listPolicies()).find(policy => policy.name === 'p.read')
          expect(record?.dependsOn).toEqual(['p.b'])
        }))
    })

    describe('S6 — deletePolicies cascades', () => {
      const cascadeSetup = async (adapter: StorageAdapter): Promise<void> => {
        await seedPolicies(adapter, ['p.keep', 'p.gone'])
        await seedGroup(adapter, 'g', [
          { policyName: 'p.keep', scope: null },
          { policyName: 'p.gone', scope: null },
        ])
        await adapter.assignGroup(ref('u1'), 'g')
        await adapter.assignPolicy(ref('u1'), 'p.keep')
        await adapter.assignPolicy(ref('u1'), 'p.gone')
        const gone = (await adapter.listPolicies()).find(policy => policy.name === 'p.gone')
        await adapter.deletePolicies([gone!.id])
      }

      it('S6: deletePolicies removes the policy rows', () =>
        withAdapter(async adapter => {
          await cascadeSetup(adapter)
          expect(names(await adapter.listPolicies())).toEqual(['p.keep'])
        }))

      it('S6: deletePolicies cascades into group policy entries', () =>
        withAdapter(async adapter => {
          await cascadeSetup(adapter)
          expect((await adapter.getGroupPolicies('g')).map(entry => entry.policyName)).toEqual([
            'p.keep',
          ])
        }))

      it('S6: deletePolicies cascades into direct assignments', () =>
        withAdapter(async adapter => {
          await cascadeSetup(adapter)
          const grants = await adapter.getSubjectPolicies(ref('u1'))
          expect(names(grants)).toEqual(['p.keep', 'p.keep'])
        }))
    })

    describe('S7 — upsertGroup idempotency', () => {
      it('S7: upsertGroup is idempotent on name and updates the label', () =>
        withAdapter(async adapter => {
          await adapter.upsertGroup({ name: 'g', label: 'One' })
          await adapter.upsertGroup({ name: 'g', label: 'Two' })
          const matches = (await adapter.listGroups()).filter(group => group.name === 'g')
          expect(matches).toHaveLength(1)
          expect(matches[0]?.label).toBe('Two')
        }))

      it('S7: on insert, omitted optional flags default to isSystem=false, isActive=true', () =>
        withAdapter(async adapter => {
          await adapter.upsertGroup({ name: 'g', label: 'One' })
          const group = (await adapter.listGroups()).find(candidate => candidate.name === 'g')
          expect(group?.isSystem).toBe(false)
          expect(group?.isActive).toBe(true)
        }))

      it('S7: on update, OMITTED optional fields keep their stored values (passing nothing never resets a flag)', () =>
        withAdapter(async adapter => {
          await adapter.upsertGroup({ name: 'g', label: 'One', isSystem: true, isActive: false })
          await adapter.upsertGroup({ name: 'g', label: 'Two' })
          const group = (await adapter.listGroups()).find(candidate => candidate.name === 'g')
          expect(group?.label).toBe('Two')
          expect(group?.isSystem).toBe(true)
          expect(group?.isActive).toBe(false)
        }))

      it('S7: on update, EXPLICIT optional fields are applied', () =>
        withAdapter(async adapter => {
          await adapter.upsertGroup({ name: 'g', label: 'One', isSystem: true, isActive: false })
          await adapter.upsertGroup({ name: 'g', label: 'Two', isSystem: false, isActive: true })
          const group = (await adapter.listGroups()).find(candidate => candidate.name === 'g')
          expect(group?.isSystem).toBe(false)
          expect(group?.isActive).toBe(true)
        }))

      it("S7: re-upserting a group never destroys or duplicates the group's policy entries", () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['a.read', 'b.read'])
          await seedGroup(adapter, 'g', [
            { policyName: 'a.read', scope: null },
            { policyName: 'b.read', scope: 'owned' },
          ])
          await adapter.upsertGroup({ name: 'g', label: 'renamed' })
          expect(sortEntries(await adapter.getGroupPolicies('g'))).toEqual([
            { policyName: 'a.read', scope: null },
            { policyName: 'b.read', scope: 'owned' },
          ])
        }))
    })

    describe('S8 — setGroupPolicies replaces exactly', () => {
      it('S8: setGroupPolicies removes absent entries, adds missing ones and updates scopes', () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['a.read', 'b.read', 'c.read'])
          await seedGroup(adapter, 'g', [
            { policyName: 'a.read', scope: null },
            { policyName: 'b.read', scope: 'owned' },
          ])
          await adapter.setGroupPolicies('g', [
            { policyName: 'b.read', scope: null },
            { policyName: 'c.read', scope: 'owned' },
          ])
          expect(sortEntries(await adapter.getGroupPolicies('g'))).toEqual([
            { policyName: 'b.read', scope: null },
            { policyName: 'c.read', scope: 'owned' },
          ])
        }))

      it('S8: setGroupPolicies never touches another group', () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['a.read', 'b.read'])
          await seedGroup(adapter, 'g1', [{ policyName: 'a.read', scope: null }])
          await seedGroup(adapter, 'g2', [{ policyName: 'b.read', scope: null }])
          await adapter.setGroupPolicies('g1', [])
          expect(await adapter.getGroupPolicies('g1')).toEqual([])
          expect(await adapter.getGroupPolicies('g2')).toEqual([
            { policyName: 'b.read', scope: null },
          ])
        }))
    })

    describe('S9 — addGroupPolicies is additive and idempotent', () => {
      it('S9: addGroupPolicies adds new entries without removing existing ones', () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['a.read', 'b.read'])
          await seedGroup(adapter, 'g', [{ policyName: 'a.read', scope: null }])
          await adapter.addGroupPolicies('g', [{ policyName: 'b.read', scope: null }])
          expect(sortEntries(await adapter.getGroupPolicies('g'))).toEqual([
            { policyName: 'a.read', scope: null },
            { policyName: 'b.read', scope: null },
          ])
        }))

      it('S9: re-adding an existing (group, policy) pair does not duplicate and keeps the existing scope', () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['a.read'])
          await seedGroup(adapter, 'g', [{ policyName: 'a.read', scope: 'owned' }])
          await adapter.addGroupPolicies('g', [{ policyName: 'a.read', scope: null }])
          expect(await adapter.getGroupPolicies('g')).toEqual([
            { policyName: 'a.read', scope: 'owned' },
          ])
        }))
    })

    describe('S10 — idempotent assignment upserts', () => {
      it('S10: assignGroup twice leaves one membership row', () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['a.read'])
          await seedGroup(adapter, 'g', [{ policyName: 'a.read', scope: null }])
          await adapter.assignGroup(ref('u1'), 'g')
          await adapter.assignGroup(ref('u1'), 'g')
          expect(await adapter.getSubjectPolicies(ref('u1'))).toHaveLength(1)
        }))

      it('S10: assignPolicy twice leaves one grant row', () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['p.read'])
          await adapter.assignPolicy(ref('u1'), 'p.read')
          await adapter.assignPolicy(ref('u1'), 'p.read')
          expect(await adapter.getSubjectPolicies(ref('u1'))).toHaveLength(1)
        }))

      it('S10: assignPolicy is an upsert — re-assigning updates the scope', () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['p.read'])
          await adapter.assignPolicy(ref('u1'), 'p.read', 'owned')
          await adapter.assignPolicy(ref('u1'), 'p.read', null)
          expect(await adapter.getSubjectPolicies(ref('u1'))).toEqual([
            { name: 'p.read', scope: null },
          ])
        }))
    })

    describe('S11 — removals match the exact tuple only', () => {
      it('S11: removeGroup removes only the exact (subject, group, domain, tenantId) tuple', () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['a.read'])
          await seedGroup(adapter, 'g', [{ policyName: 'a.read', scope: null }])
          await adapter.assignGroup(ref('u1', 'p', 'c1'), 'g')
          await adapter.assignGroup(ref('u1', 'p', 'c2'), 'g')
          await adapter.removeGroup(ref('u1', 'p', 'c2'), 'g')
          expect(names(await adapter.getSubjectPolicies(ref('u1', 'p', 'c1')))).toEqual(['a.read'])
          expect(await adapter.getSubjectPolicies(ref('u1', 'p', 'c2'))).toEqual([])
        }))

      it('S11: removePolicy removes only the exact tuple', () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['p.read'])
          await adapter.assignPolicy(ref('u1', 'p', 'c1'), 'p.read')
          await adapter.assignPolicy(ref('u1', 'p', 'c2'), 'p.read')
          await adapter.removePolicy(ref('u1', 'p', 'c2'), 'p.read')
          expect(names(await adapter.getSubjectPolicies(ref('u1', 'p', 'c1')))).toEqual(['p.read'])
          expect(await adapter.getSubjectPolicies(ref('u1', 'p', 'c2'))).toEqual([])
        }))

      it('S11: removePolicy with a non-matching tenantId is a no-op', () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['p.read'])
          await adapter.assignPolicy(ref('u1', 'p', 'c1'), 'p.read')
          await adapter.removePolicy(ref('u1', 'p', ''), 'p.read')
          expect(names(await adapter.getSubjectPolicies(ref('u1', 'p', 'c1')))).toEqual(['p.read'])
        }))
    })

    describe('S12 — unknown policies are rejected', () => {
      it('S12: assignPolicy rejects with UnknownPolicyError for an unsynced policy', () =>
        withAdapter(async adapter => {
          let caught: unknown
          try {
            await adapter.assignPolicy(ref('u1'), 'ghost.read')
          } catch (error) {
            caught = error
          }
          expect(caught).toBeInstanceOf(Error)
          expect((caught as Error).name).toBe('UnknownPolicyError')
        }))
    })

    describe('S13 — ownership upsert semantics', () => {
      it('S13: recordOwnership upserts — recording the same entry twice leaves one row', () =>
        withAdapter(async adapter => {
          const entry = {
            resourceType: 'post',
            resourceId: '1',
            ownerId: 'u1',
            domain: '',
            tenantId: '',
          }
          await adapter.recordOwnership([entry])
          await adapter.recordOwnership([{ ...entry, domain: 'admin', tenantId: 'c1' }])
          expect(await adapter.isOwner('u1', { type: 'post', id: '1' })).toBe(true)
          expect(await adapter.getAccess?.({ type: 'post', id: '1' })).toHaveLength(1)
          await adapter.removeOwnership({ type: 'post', id: '1' })
          expect(await adapter.isOwner('u1', { type: 'post', id: '1' })).toBe(false)
        }))

      it('S13: isOwner requires an exact (ownerId, type, id) match', () =>
        withAdapter(async adapter => {
          await adapter.recordOwnership([
            { resourceType: 'post', resourceId: '1', ownerId: 'u1', domain: '', tenantId: '' },
          ])
          expect(await adapter.isOwner('u1', { type: 'post', id: '1' })).toBe(true)
          expect(await adapter.isOwner('u2', { type: 'post', id: '1' })).toBe(false)
          expect(await adapter.isOwner('u1', { type: 'post', id: '2' })).toBe(false)
          expect(await adapter.isOwner('u1', { type: 'comment', id: '1' })).toBe(false)
        }))

      it('S13: removeOwnership removes ALL owners and ALL relations of the resource and nothing else', () =>
        withAdapter(async adapter => {
          await adapter.recordOwnership([
            { resourceType: 'post', resourceId: '1', ownerId: 'u1', domain: '', tenantId: '' },
            { resourceType: 'post', resourceId: '1', ownerId: 'u2', domain: '', tenantId: '' },
            {
              resourceType: 'post',
              resourceId: '1',
              ownerId: 'u3',
              relation: 'granted',
              domain: '',
              tenantId: '',
            },
            { resourceType: 'post', resourceId: '2', ownerId: 'u1', domain: '', tenantId: '' },
          ])
          await adapter.removeOwnership({ type: 'post', id: '1' })
          expect(await adapter.isOwner('u1', { type: 'post', id: '1' })).toBe(false)
          expect(await adapter.isOwner('u2', { type: 'post', id: '1' })).toBe(false)
          expect(await adapter.getAccess?.({ type: 'post', id: '1' })).toEqual([])
          expect(await adapter.isOwner('u1', { type: 'post', id: '2' })).toBe(true)
        }))
    })

    describe('S14 — listPolicies ids', () => {
      it('S14: listPolicies returns stable, opaque, non-empty ids with name and dependsOn', () =>
        withAdapter(async adapter => {
          await adapter.upsertPolicies([row('p.a'), row('p.b', { dependsOn: ['p.a'] })])
          const first = await adapter.listPolicies()
          const second = await adapter.listPolicies()
          for (const record of first) {
            expect(typeof record.id).toBe('string')
            expect(record.id.length).toBeGreaterThan(0)
          }
          const idsByName = (list: { name: string; id: string }[]): Record<string, string> =>
            Object.fromEntries(list.map(policy => [policy.name, policy.id]))
          expect(idsByName(second)).toEqual(idsByName(first))
          expect(first.find(policy => policy.name === 'p.b')?.dependsOn).toEqual(['p.a'])
        }))
    })

    describe('S16 — getGroupPolicies returns names', () => {
      it('S16: getGroupPolicies returns qualified policy NAMES with scopes, not ids', () =>
        withAdapter(async adapter => {
          await seedPolicies(adapter, ['admin.posts.read'], 'admin')
          await seedGroup(adapter, 'g', [{ policyName: 'admin.posts.read', scope: 'owned' }])
          expect(await adapter.getGroupPolicies('g')).toEqual([
            { policyName: 'admin.posts.read', scope: 'owned' },
          ])
        }))
    })

    describe('S17 — ensureSchema idempotency', () => {
      it('S17: ensureSchema (when implemented) is idempotent across repeated sync runs', () =>
        withAdapter(async adapter => {
          await adapter.ensureSchema?.()
          await adapter.ensureSchema?.()
          await seedPolicies(adapter, ['p.read'])
          expect(names(await adapter.listPolicies())).toContain('p.read')
        }))
    })

    describe('S18 — errors are surfaced, never swallowed', () => {
      // Missing tables cannot be provoked portably from the suite; the
      // observable floor is that invalid mutations reject instead of
      // silently no-opping.
      it('S18: invalid mutations reject with an Error — never a silent no-op', () =>
        withAdapter(async adapter => {
          let caught: unknown
          try {
            await adapter.assignPolicy(ref('u1'), 'never.synced')
          } catch (error) {
            caught = error
          }
          expect(caught).toBeInstanceOf(Error)
        }))
    })

    describe('S19 — domain column drives orphan filtering', () => {
      it('S19: listPolicies exposes the stored domain for filtering', () =>
        withAdapter(async adapter => {
          await adapter.upsertPolicies([
            row('admin.posts.read', { domain: 'admin' }),
            row('standalone.read'),
          ])
          const list = await adapter.listPolicies()
          expect(list.find(policy => policy.name === 'admin.posts.read')?.domain).toBe('admin')
          expect(list.find(policy => policy.name === 'standalone.read')?.domain).toBe('')
        }))

      it("S19: domain-scoped orphan delete never touches another domain's dotted-name policies (v0 name-shape regression)", () =>
        withAdapter(async adapter => {
          // A policy with no domain whose NAME looks like it belongs to 'admin'.
          await adapter.upsertPolicies([row('admin.posts.read', { domain: '' })])
          await adapter.upsertPolicies([row('admin.users.read', { domain: 'admin' })])
          const orphans = (await adapter.listPolicies()).filter(policy => policy.domain === 'admin')
          await adapter.deletePolicies(orphans.map(policy => policy.id))
          const remaining = names(await adapter.listPolicies())
          expect(remaining).toContain('admin.posts.read')
          expect(remaining).not.toContain('admin.users.read')
        }))
    })

    describe('S20 — inactive groups are a kill-switch', () => {
      const killSwitchSetup = async (adapter: StorageAdapter): Promise<void> => {
        await seedPolicies(adapter, ['a.read', 'b.read'])
        await seedGroup(adapter, 'g', [{ policyName: 'a.read', scope: null }])
        await adapter.assignGroup(ref('u1'), 'g')
        await adapter.assignPolicy(ref('u1'), 'b.read')
      }

      it('S20: grants from a group with isActive=false are excluded from getSubjectPolicies', () =>
        withAdapter(async adapter => {
          await killSwitchSetup(adapter)
          expect(names(await adapter.getSubjectPolicies(ref('u1')))).toEqual(['a.read', 'b.read'])
          await adapter.upsertGroup({ name: 'g', label: 'g', isActive: false })
          expect(names(await adapter.getSubjectPolicies(ref('u1')))).toEqual(['b.read'])
        }))

      it('S20: direct grants are unaffected by deactivating an unrelated group', () =>
        withAdapter(async adapter => {
          await killSwitchSetup(adapter)
          await adapter.upsertGroup({ name: 'g', label: 'g', isActive: false })
          const grants = await adapter.getSubjectPolicies(ref('u1'))
          expect(grants).toEqual([{ name: 'b.read', scope: null }])
        }))

      it('S20: reactivating the group restores its grants', () =>
        withAdapter(async adapter => {
          await killSwitchSetup(adapter)
          await adapter.upsertGroup({ name: 'g', label: 'g', isActive: false })
          expect(names(await adapter.getSubjectPolicies(ref('u1')))).toEqual(['b.read'])
          await adapter.upsertGroup({ name: 'g', label: 'g', isActive: true })
          expect(names(await adapter.getSubjectPolicies(ref('u1')))).toEqual(['a.read', 'b.read'])
        }))
    })

    const access = (
      ownerId: string,
      relation?: string,
      over: Partial<Pick<OwnershipEntry, 'resourceType' | 'resourceId' | 'domain' | 'tenantId'>> = {},
    ): OwnershipEntry => ({
      resourceType: 'post',
      resourceId: '1',
      ownerId,
      ...(relation === undefined ? {} : { relation }),
      domain: '',
      tenantId: '',
      ...over,
    })

    const byOwnerAndRelation = (entries: OwnershipEntry[]): [string, string | undefined][] =>
      entries
        .map((entry): [string, string | undefined] => [entry.ownerId, entry.relation])
        .sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`))

    describe('S21 — getAccess returns every relation', () => {
      it("S21: getAccess returns every stored entry for the resource — all owners, all relations, relation populated", () =>
        withAdapter(async adapter => {
          await adapter.recordOwnership([
            access('u1'),
            access('u2', 'granted'),
            access('u3', 'reviewer'),
            access('u1', undefined, { resourceId: '2' }),
          ])
          const entries = await adapter.getAccess!({ type: 'post', id: '1' })
          expect(byOwnerAndRelation(entries)).toEqual([
            ['u1', 'owner'],
            ['u2', 'granted'],
            ['u3', 'reviewer'],
          ])
        }))

      it('S21: getAccess returns [] for a resource with no entries', () =>
        withAdapter(async adapter => {
          await adapter.recordOwnership([access('u1')])
          expect(await adapter.getAccess!({ type: 'post', id: '404' })).toEqual([])
          expect(await adapter.getAccess!({ type: 'comment', id: '1' })).toEqual([])
        }))
    })

    describe('S22 — relation-keyed upsert; isOwner is relation-owner-only', () => {
      it('S22: recordOwnership upserts on (resourceType, resourceId, ownerId, relation) — same tuple twice leaves one row', () =>
        withAdapter(async adapter => {
          await adapter.recordOwnership([access('u1', 'granted')])
          await adapter.recordOwnership([
            access('u1', 'granted', { domain: 'admin', tenantId: 'c1' }),
          ])
          expect(await adapter.getAccess!({ type: 'post', id: '1' })).toHaveLength(1)
        }))

      it('S22: one owner may hold several relations on one resource — distinct relations are distinct rows', () =>
        withAdapter(async adapter => {
          await adapter.recordOwnership([access('u1', 'owner'), access('u1', 'granted')])
          expect(byOwnerAndRelation(await adapter.getAccess!({ type: 'post', id: '1' }))).toEqual([
            ['u1', 'granted'],
            ['u1', 'owner'],
          ])
        }))

      it("S22: an omitted relation is stored as 'owner'", () =>
        withAdapter(async adapter => {
          await adapter.recordOwnership([access('u1')])
          const entries = await adapter.getAccess!({ type: 'post', id: '1' })
          expect(entries).toHaveLength(1)
          expect(entries[0]?.relation).toBe('owner')
          expect(await adapter.isOwner('u1', { type: 'post', id: '1' })).toBe(true)
        }))

      it("S22: isOwner matches ONLY relation-'owner' rows — a 'granted' entry never makes isOwner true", () =>
        withAdapter(async adapter => {
          await adapter.recordOwnership([access('u1', 'granted')])
          expect(await adapter.isOwner('u1', { type: 'post', id: '1' })).toBe(false)
          await adapter.recordOwnership([access('u1', 'owner')])
          expect(await adapter.isOwner('u1', { type: 'post', id: '1' })).toBe(true)
        }))
    })

    describe('S23 — removeAccess matches exactly', () => {
      const seedAccess = (adapter: StorageAdapter): Promise<void> =>
        adapter.recordOwnership([
          access('u1', 'owner'),
          access('u1', 'granted'),
          access('u2', 'granted'),
          access('u1', 'owner', { resourceId: '2' }),
        ])

      it("S23: removeAccess with a relation removes only that owner's entries in that relation", () =>
        withAdapter(async adapter => {
          await seedAccess(adapter)
          await adapter.removeAccess!('u1', { type: 'post', id: '1' }, 'granted')
          expect(byOwnerAndRelation(await adapter.getAccess!({ type: 'post', id: '1' }))).toEqual([
            ['u1', 'owner'],
            ['u2', 'granted'],
          ])
          expect(await adapter.isOwner('u1', { type: 'post', id: '1' })).toBe(true)
        }))

      it("S23: removeAccess without a relation removes every relation for that owner — other owners survive", () =>
        withAdapter(async adapter => {
          await seedAccess(adapter)
          await adapter.removeAccess!('u1', { type: 'post', id: '1' })
          expect(byOwnerAndRelation(await adapter.getAccess!({ type: 'post', id: '1' }))).toEqual([
            ['u2', 'granted'],
          ])
        }))

      it('S23: removeAccess never touches other resources', () =>
        withAdapter(async adapter => {
          await seedAccess(adapter)
          await adapter.removeAccess!('u1', { type: 'post', id: '1' })
          expect(await adapter.isOwner('u1', { type: 'post', id: '2' })).toBe(true)
        }))

      it('S23: removeAccess with a non-matching relation is a no-op', () =>
        withAdapter(async adapter => {
          await seedAccess(adapter)
          await adapter.removeAccess!('u2', { type: 'post', id: '1' }, 'owner')
          expect(byOwnerAndRelation(await adapter.getAccess!({ type: 'post', id: '1' }))).toEqual([
            ['u1', 'granted'],
            ['u1', 'owner'],
            ['u2', 'granted'],
          ])
        }))
    })
  })
}
