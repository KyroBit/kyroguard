/// <reference types="bun-types" />
/**
 * Reference-adapter specifics that are NOT portable enough for the shared
 * contract suite: defensive copying. Grants returned by getSubjectPolicies
 * (and entries from getGroupPolicies) are copies — mutating a returned object
 * never corrupts the store. Input entries are copied too — mutating an
 * argument object after the call has no effect.
 */

import { describe, expect, test } from 'bun:test'

import { memoryAdapter } from '../../src/testing/index.js'

const ref = (subjectId: string, domain = '', tenantId = '') => ({ subjectId, domain, tenantId })

describe('memory adapter extras', () => {
  describe('defensive copies from read paths', () => {
    test('mutating a grant returned by getSubjectPolicies does not corrupt the store', async () => {
      const adapter = memoryAdapter()
      await adapter.upsertPolicies([
        { name: 'a.read', domain: '', label: 'a', scopeOptions: [], dependsOn: [] },
        { name: 'b.read', domain: '', label: 'b', scopeOptions: [], dependsOn: [] },
      ])
      await adapter.upsertGroup({ name: 'g', label: 'g' })
      await adapter.setGroupPolicies('g', [{ policyName: 'a.read', scope: 'owned' }])
      await adapter.assignGroup(ref('u1'), 'g')
      await adapter.assignPolicy(ref('u1'), 'b.read', null)

      const grants = await adapter.getSubjectPolicies(ref('u1'))
      expect(grants).toEqual([
        { name: 'a.read', scope: 'owned' },
        { name: 'b.read', scope: null },
      ])
      for (const grant of grants) {
        grant.name = 'evil.write'
        grant.scope = null
      }
      expect(await adapter.getSubjectPolicies(ref('u1'))).toEqual([
        { name: 'a.read', scope: 'owned' },
        { name: 'b.read', scope: null },
      ])
    })

    test('mutating an entry returned by getGroupPolicies does not corrupt the store', async () => {
      const adapter = memoryAdapter()
      await adapter.upsertPolicies([
        { name: 'a.read', domain: '', label: 'a', scopeOptions: [], dependsOn: [] },
      ])
      await adapter.upsertGroup({ name: 'g', label: 'g' })
      await adapter.setGroupPolicies('g', [{ policyName: 'a.read', scope: 'owned' }])

      const entries = await adapter.getGroupPolicies('g')
      entries[0]!.policyName = 'evil.write'
      entries[0]!.scope = null
      expect(await adapter.getGroupPolicies('g')).toEqual([
        { policyName: 'a.read', scope: 'owned' },
      ])
    })

    test('setGroupPolicies copies its input — mutating the argument array afterwards has no effect', async () => {
      const adapter = memoryAdapter()
      await adapter.upsertPolicies([
        { name: 'a.read', domain: '', label: 'a', scopeOptions: [], dependsOn: [] },
      ])
      await adapter.upsertGroup({ name: 'g', label: 'g' })
      const input = [{ policyName: 'a.read', scope: 'owned' as string | null }]
      await adapter.setGroupPolicies('g', input)
      input[0]!.policyName = 'evil.write'
      input.push({ policyName: 'sneaky.read', scope: null })
      expect(await adapter.getGroupPolicies('g')).toEqual([
        { policyName: 'a.read', scope: 'owned' },
      ])
    })
  })
})
