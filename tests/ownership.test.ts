/**
 * Ownership tracking — createTrackedDb
 *
 * Every insert through the tracked proxy must write a row to resourceOwners.
 * Inserts through db.untracked must NOT. The owner and context are taken from
 * the current ALS request context.
 */
import { describe, test, expect } from 'bun:test'
import { storage } from '../src/store.js'
import { createTrackedDb, RBAC_SCOPES } from '../src/proxy.js'
import { Policy } from '../src/policy.js'
import { Scope } from '../src/scope.js'
import type { ResourceDefinition } from '../src/policy.js'

// ─── Minimal fake DB ──────────────────────────────────────────────────────────

function createFakeDb() {
  const insertedRows: { table: string; values: any[] }[] = []

  const db: any = {
    _rows: insertedRows,
    insert(table: any) {
      return {
        values(data: any) {
          const rows = (Array.isArray(data) ? data : [data]).map((r: any, i: number) => ({
            id: r.id ?? `generated-${i}`,
            ...r,
          }))
          insertedRows.push({ table: table._name ?? 'unknown', values: rows })

          // Supports both: await db.insert(t).values(...)        (no .returning)
          //           and: await db.insert(t).values(...).returning()
          const resultPromise: any = Promise.resolve(rows)
          resultPromise.returning = () => Promise.resolve(rows)
          return resultPromise
        },
      }
    },
    select() {
      return { from() { return Promise.resolve([]) } }
    },
  }

  return db
}

// Fake table references
const postsTable:    any = { _name: 'posts' }
const commentsTable: any = { _name: 'comments' }

const resources: ResourceDefinition[] = [
  {
    table:    postsTable,
    type:     'post',
    policies: [new Policy('post.create')],
  },
  {
    table:    commentsTable,
    type:     'comment',
    policies: [new Policy('comment.create')],
  },
]

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createTrackedDb — ownership recording', () => {
  test('RBAC_SCOPES symbol returns collected scopes', () => {
    const scope  = new Scope('own-post', 'Own Post', () => true)
    const res: ResourceDefinition[] = [
      {
        table:    postsTable,
        type:     'post',
        policies: [new Policy('post.update', 'Update', [], [scope])],
      },
    ]

    const rawDb = createFakeDb()
    const db    = createTrackedDb(rawDb, { resources: res })

    const scopes = (db as any)[RBAC_SCOPES]
    expect(scopes).toHaveLength(1)
    expect(scopes[0].name).toBe('own-post')
  })

  test('db.untracked returns the raw db, bypassing tracking', () => {
    const rawDb = createFakeDb()
    const db    = createTrackedDb(rawDb, { resources })

    expect((db as any).untracked).toBe(rawDb)
  })

  test('insert through tracked db records ownership in resourceOwners', async () => {
    const rawDb        = createFakeDb()
    const db           = createTrackedDb(rawDb, { resources })
    const ownedInserts = rawDb._rows

    await storage.run(
      { subject: { id: 'alice', portal: 'admin' }, context: 'branch-1', extraOnce: null },
      async () => {
        await db.insert(postsTable).values([{ id: 'post-1', title: 'Hello' }]).returning()
      },
    )

    const ownershipRow = ownedInserts.find((r: any) => r.table === 'unknown' && r.values[0]?.owner_id)
    expect(ownershipRow).toBeDefined()
    expect(ownershipRow!.values[0]).toMatchObject({
      resource_type: 'post',
      resource_id:   'post-1',
      owner_id:      'alice',
      context_type:  'admin',
      context_id:    'branch-1',
    })
  })

  test('insert through db.untracked does NOT record ownership', async () => {
    const rawDb        = createFakeDb()
    const db           = createTrackedDb(rawDb, { resources })
    const ownedInserts = rawDb._rows

    await storage.run(
      { subject: { id: 'alice', portal: 'admin' }, context: 'branch-1', extraOnce: null },
      async () => {
        await db.untracked.insert(postsTable).values([{ id: 'post-2', title: 'Untracked' }]).returning()
      },
    )

    const ownershipRow = ownedInserts.find((r: any) => r.values[0]?.owner_id)
    expect(ownershipRow).toBeUndefined()
  })

  test('insert on unregistered table does NOT record ownership', async () => {
    const rawDb        = createFakeDb()
    const db           = createTrackedDb(rawDb, { resources })
    const ownedInserts = rawDb._rows

    const unknownTable: any = { _name: 'users' }

    await storage.run(
      { subject: { id: 'alice', portal: 'admin' }, context: '', extraOnce: null },
      async () => {
        await db.insert(unknownTable).values([{ id: 'u-1', email: 'a@a.com' }]).returning()
      },
    )

    const ownershipRow = ownedInserts.find((r: any) => r.values[0]?.owner_id)
    expect(ownershipRow).toBeUndefined()
  })

  test('insert outside a request context (no ALS store) does NOT throw and records nothing', async () => {
    const rawDb        = createFakeDb()
    const db           = createTrackedDb(rawDb, { resources })
    const ownedInserts = rawDb._rows
    const before       = ownedInserts.length

    // No storage.run() — simulates CLI / seeder context
    await db.insert(postsTable).values([{ id: 'seed-1' }]).returning()

    expect(ownedInserts.length).toBe(before + 1) // the user insert, but no ownership row
    const ownershipRow = ownedInserts.find((r: any) => r.values[0]?.owner_id)
    expect(ownershipRow).toBeUndefined()
  })

  test('context_id on ownership row is null when store.context is empty', async () => {
    const rawDb        = createFakeDb()
    const db           = createTrackedDb(rawDb, { resources })
    const ownedInserts = rawDb._rows

    await storage.run(
      { subject: { id: 'alice', portal: 'admin' }, context: '', extraOnce: null },
      async () => {
        await db.insert(postsTable).values([{ id: 'post-3' }]).returning()
      },
    )

    const ownershipRow = ownedInserts.find((r: any) => r.values[0]?.owner_id)
    expect(ownershipRow).toBeDefined()
    expect(ownershipRow!.values[0].context_id).toBeNull()
  })
})
