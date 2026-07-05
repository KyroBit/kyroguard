import { describe, test, expect } from 'bun:test'
import { Policy } from '../../src/core/policy.js'
import { Scope } from '../../src/core/scope.js'

describe('Policy labels', () => {
  test('derived from resource.action names: action first, then resource', () => {
    expect(new Policy('sales.create').label).toBe('Create sales')
    expect(new Policy('sales.void').label).toBe('Void sales')
    expect(new Policy('products.update').label).toBe('Update products')
  })

  test('hyphens become spaces in both parts', () => {
    expect(new Policy('blog-category.read').label).toBe('Read blog category')
    expect(new Policy('sales.mark-paid').label).toBe('Mark paid sales')
  })

  test('single-segment names are just capitalized', () => {
    expect(new Policy('dashboard').label).toBe('Dashboard')
  })

  test('deeper names keep everything before the action as the resource', () => {
    expect(new Policy('reports.finance.view').label).toBe('View reports finance')
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
    expect(policy.label).toBe('Void sales')
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
