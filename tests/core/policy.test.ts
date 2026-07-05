import { describe, test, expect } from 'bun:test'
import { Policy } from '../../src/core/policy.js'
import { Scope } from '../../src/core/scope.js'

describe('Policy labels', () => {
  test('derived from the action part only — admin UIs group by resource', () => {
    expect(new Policy('sales.create').label).toBe('Create')
    expect(new Policy('sales.void').label).toBe('Void')
    expect(new Policy('products.update').label).toBe('Update')
  })

  test('hyphens become spaces', () => {
    expect(new Policy('sales.mark-paid').label).toBe('Mark paid')
    expect(new Policy('blog-category.read').label).toBe('Read')
  })

  test('single-segment names are just capitalized', () => {
    expect(new Policy('dashboard').label).toBe('Dashboard')
  })

  test('deeper names still use only the last segment', () => {
    expect(new Policy('reports.finance.view').label).toBe('View')
  })

  test('an explicit label always wins', () => {
    expect(new Policy('sales.create', 'Record a sale').label).toBe('Record a sale')
  })
})

describe('Policy options form', () => {
  test('options object replaces the positional undefined hole', () => {
    const owned = Scope.owned()
    const policy = new Policy('sales.void', {
      dependsOn: ['sales.view'],
      scopeOptions: [owned],
    })
    expect(policy.label).toBe('Void')
    expect(policy.dependsOn).toEqual(['sales.view'])
    expect(policy.scopeOptions).toEqual([owned])
  })

  test('options object may still set the label', () => {
    const policy = new Policy('sales.void', { label: 'Cancel sale' })
    expect(policy.label).toBe('Cancel sale')
  })

  test('positional form keeps working', () => {
    const policy = new Policy('sales.void', 'Void sales', ['sales.view'])
    expect(policy.label).toBe('Void sales')
    expect(policy.dependsOn).toEqual(['sales.view'])
  })
})

describe('Scope name reservation', () => {
  test("a Scope named 'all' throws — 'all' is the unrestricted-grant marker", () => {
    expect(() => new Scope('all', 'Everything', () => true)).toThrow(/'all' is reserved/)
  })

  test('the built-in factories reject the reserved name too', () => {
    expect(() => Scope.owned('all')).toThrow(/'all' is reserved/)
  })
})
