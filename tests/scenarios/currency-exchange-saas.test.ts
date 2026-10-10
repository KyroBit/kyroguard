/// <reference types="bun-types" />
/**
 * The three-tier currency-exchange SAAS, end to end over HTTP. Every assertion
 * is one of the architecture's stated rules, so a rule the library cannot
 * express fails here rather than in an application.
 *
 * Laid out as a real project would be: one policies set per domain, and the
 * guard plus its domains as plain values (src/kyroguard/domains.ts), so routes
 * and seeders use the same instances.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { pgTable, text } from 'drizzle-orm/pg-core'
import type { PgColumn } from 'drizzle-orm/pg-core'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

import { Policy, Scope, createGuard } from '../../src/index.js'
import type {
  Guard,
  ResourceDefinition,
  ScopeContext,
  Subject,
  SubjectInput,
} from '../../src/index.js'
import { createDomain, kyroguardFastify } from '../../src/frameworks/fastify/index.js'
import type { FastifyDomain } from '../../src/frameworks/fastify/index.js'
import { drizzleAdapter, scopedDb } from '../../src/storage/drizzle/index.js'
import * as pgSchema from '../../src/storage/drizzle/schema/pg.js'
import { KYROGUARD_PG_DDL } from '../storage/helpers/pg.js'

// ── src/db/schema.ts ──────────────────────────────────────────────────────────

/** Shared across every branch of one business — one customer profile per business. */
const customers = pgTable('customers', {
  id: text('id').primaryKey(),
  businessId: text('business_id').notNull(),
  name: text('name').notNull(),
})

/** Strictly branch-local: the trade happened at one branch and stays there. */
const transactions = pgTable('transactions', {
  id: text('id').primaryKey(),
  businessId: text('business_id').notNull(),
  branchId: text('branch_id').notNull(),
  amount: text('amount').notNull(),
})

/** Who may sign in at which branch. Membership churns; the business does not. */
const branchMembers = pgTable('branch_members', {
  userId: text('user_id').notNull(),
  branchId: text('branch_id').notNull(),
})

/** The platform's own staff. is_super skips scopes, so only these may hold it. */
const platformOperators = pgTable('platform_operators', {
  userId: text('user_id').primaryKey(),
})

/** SAAS-owner data: the same rows for every business, never scoped. */
const countries = pgTable('countries', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

const schema = { customers, transactions, countries, branchMembers, platformOperators }

const USER_DDL = `
CREATE TABLE "customers" ("id" text PRIMARY KEY, "business_id" text NOT NULL, "name" text NOT NULL);
CREATE TABLE "transactions" (
  "id" text PRIMARY KEY,
  "business_id" text NOT NULL,
  "branch_id" text NOT NULL,
  "amount" text NOT NULL
);
CREATE TABLE "countries" ("id" text PRIMARY KEY, "name" text NOT NULL);
CREATE TABLE "branch_members" ("user_id" text NOT NULL, "branch_id" text NOT NULL);
CREATE TABLE "platform_operators" ("user_id" text PRIMARY KEY);
`

// ── src/kyroguard/scopes.ts ───────────────────────────────────────────────────

/**
 * Both tenancy scopes are one shape: a conventional column on the resource's
 * table, matched against a field the session carries. Anything missing is a
 * wiring mistake, so it says so rather than quietly returning no rows.
 */
function tenantColumn(ctx: ScopeContext, column: string): PgColumn {
  const table = ctx.resource.table as Record<string, PgColumn> | undefined
  const found = table?.[column]
  if (!found) {
    throw new Error(
      `[scope] resource "${ctx.resource.type}" has no "${column}" column — ` +
        `either it should not be granted this scope, or the column is missing from the table.`,
    )
  }
  return found
}

function sessionValue(subject: Subject, key: string): string {
  const value = subject[key]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`[scope] the session carries no "${key}" — getSubject must set it.`)
  }
  return value
}

// The tenant IS the business, so this reads tenant_id — there is no second
// field carrying the same value.
const inBusiness = new Scope('in-business', 'This business', {
  match: (subject, ctx) => ({
    where: eq(tenantColumn(ctx, 'businessId'), sessionValue(subject, 'tenant_id')),
  }),
  insert: subject => ({ businessId: sessionValue(subject, 'tenant_id') }),
})

const inBranch = new Scope('in-branch', 'This branch', {
  match: (subject, ctx) => ({
    where: eq(tenantColumn(ctx, 'branchId'), sessionValue(subject, 'branch_id')),
  }),
  insert: subject => ({ branchId: sessionValue(subject, 'branch_id') }),
})

// ── src/kyroguard/policies/portal.ts ──────────────────────────────────────────

/** The business owner's app: consolidated across every branch they own. */
const portalResources: ResourceDefinition[] = [
  {
    type: 'customer',
    table: customers,
    policies: [new Policy('customer.read', { scopeOptions: [inBusiness] })],
  },
  {
    type: 'transaction',
    table: transactions,
    // Only in-business is offered here, so a portal grant scoped to one branch
    // is rejected at assignment rather than discovered in production.
    policies: [new Policy('transaction.read', { scopeOptions: [inBusiness] })],
  },
]

// ── src/kyroguard/policies/branch.ts ──────────────────────────────────────────

/** The counter app: branch-local trades, business-wide customers. */
const branchResources: ResourceDefinition[] = [
  {
    type: 'customer',
    table: customers,
    policies: [new Policy('customer.read', { scopeOptions: [inBusiness] })],
  },
  {
    type: 'transaction',
    table: transactions,
    policies: [
      new Policy('transaction.read', { scopeOptions: [inBranch] }),
      new Policy('transaction.create', { dependsOn: ['transaction.read'], scopeOptions: [inBranch] }),
      new Policy('transaction.update', {
        dependsOn: ['transaction.read'],
        scopeOptions: [inBranch],
      }),
    ],
  },
  {
    type: 'country',
    table: countries,
    policies: [new Policy('country.read')],
  },
]

// ── src/kyroguard/domains.ts ──────────────────────────────────────────────────

let app: FastifyInstance
let guard: Guard
let portal: FastifyDomain
let branch: FastifyDomain
let rawDb: ReturnType<typeof drizzle<typeof schema>>
let close: () => Promise<void>

/**
 * The tenant is the BUSINESS on every tier — a cashier standing in a branch
 * still belongs to the business, and moving branch must not move their tenant.
 * Which branch they are working in is session context the scopes read.
 */
async function subjectFrom(
  headers: Record<string, unknown>,
  level: 'portal' | 'branch',
): Promise<SubjectInput | null> {
  const id = headers['x-user']
  const business = headers['x-business']
  if (typeof id !== 'string' || id === '' || typeof business !== 'string') return null

  const subject: SubjectInput = { id, tenant_id: business }

  // is_super bypasses scopes, so tenant isolation does not survive it. Only the
  // platform's own staff may hold it — a business owner is a group, below.
  const [operator] = await rawDb
    .select()
    .from(platformOperators)
    .where(eq(platformOperators.userId, id))
  if (operator) subject.is_super = true

  if (level === 'portal') return subject

  // Branch membership is authentication, not authorization: no membership row,
  // no session at this branch, so no guard ever runs.
  const branchId = headers['x-branch']
  if (typeof branchId !== 'string') return null
  const [member] = await rawDb
    .select()
    .from(branchMembers)
    .where(and(eq(branchMembers.userId, id), eq(branchMembers.branchId, branchId)))
  if (!member) return null

  subject.branch_id = branchId
  return subject
}

beforeAll(async () => {
  const client = new PGlite()
  await client.exec(KYROGUARD_PG_DDL)
  await client.exec(USER_DDL)

  rawDb = drizzle(client, { schema })
  guard = createGuard({ adapter: drizzleAdapter(rawDb, { schema: pgSchema }), cache: false })

  portal = createDomain(guard, 'portal', {
    resources: portalResources,
    getSubject: req => subjectFrom(req.headers, 'portal'),
  })
  branch = createDomain(guard, 'branch', {
    resources: branchResources,
    getSubject: req => subjectFrom(req.headers, 'branch'),
  })

  const db = scopedDb(rawDb, {
    guard: { engine: guard.engine },
    resources: [...portalResources, ...branchResources],
    schema,
  })

  await guard.sync(portalResources, 'portal')
  await guard.sync(branchResources, 'branch')

  await rawDb.insert(countries).values([
    { id: 'pk', name: 'Pakistan' },
    { id: 'ae', name: 'UAE' },
  ])
  await rawDb.insert(platformOperators).values([{ userId: 'saas-staff' }])
  await rawDb.insert(branchMembers).values([
    { userId: 'cashier-a', branchId: 'branch-a' },
    { userId: 'roamer', branchId: 'branch-a' },
  ])
  await rawDb.insert(customers).values([
    { id: 'cust-a', businessId: 'business-1', name: 'Registered at branch-a' },
    { id: 'cust-b', businessId: 'business-1', name: 'Registered at branch-b' },
    { id: 'cust-x', businessId: 'business-2', name: 'Another business entirely' },
  ])
  await rawDb.insert(transactions).values([
    { id: 'tx-a1', businessId: 'business-1', branchId: 'branch-a', amount: '100' },
    { id: 'tx-b1', businessId: 'business-1', branchId: 'branch-b', amount: '200' },
    { id: 'tx-x1', businessId: 'business-2', branchId: 'branch-x', amount: '300' },
  ])

  app = Fastify()
  await app.register(kyroguardFastify(guard))

  const list = (table: typeof customers | typeof transactions | typeof countries) => async () =>
    (await db.select().from(table as never)).map((row: { id: string }) => row.id).sort()

  app.get('/portal/customers', { preHandler: portal.requirePolicy('customer.read') }, list(customers))
  app.get(
    '/portal/transactions',
    { preHandler: portal.requirePolicy('transaction.read') },
    list(transactions),
  )
  app.get('/branch/customers', { preHandler: branch.requirePolicy('customer.read') }, list(customers))
  app.get(
    '/branch/transactions',
    { preHandler: branch.requirePolicy('transaction.read') },
    list(transactions),
  )
  app.get('/branch/countries', { preHandler: branch.requirePolicy('country.read') }, list(countries))

  app.post<{ Body: { id: string; amount: string; branchId?: string } }>(
    '/branch/transactions',
    { preHandler: branch.requirePolicy('transaction.create') },
    async request => {
      const [row] = await db
        .insert(transactions)
        // branchId is filled by the grant's scope. Drizzle's types still
        // require it because the column is notNull, hence the cast.
        .values({
          id: request.body.id,
          amount: request.body.amount,
          businessId: request.headers['x-business'] as string,
          ...(request.body.branchId ? { branchId: request.body.branchId } : {}),
        } as typeof transactions.$inferInsert)
        .returning()
      return { created: row?.id, branchId: row?.branchId }
    },
  )

  app.patch<{ Params: { id: string } }>(
    '/branch/transactions/:id',
    { preHandler: branch.requirePolicy('transaction.update') },
    async request => {
      const changed = await db
        .update(transactions)
        .set({ amount: '999' })
        .where(eq(transactions.id, request.params.id))
        .returning()
      return { changed: changed.map(row => row.id) }
    },
  )

  await app.ready()
  close = async () => {
    await app.close()
    guard.dispose()
    await client.close()
  }

  // The business owner is a ROLE, not a bypass: every policy the portal has,
  // each scoped to their own business.
  await guard.seedGroups(
    {
      // Group names are globally unique — the groups table has no domain column.
      // 'all' takes each policy's declared reach, so new portal policies join
      // the owner's role already confined to their business.
      'business-owner': { label: 'Business owner', policies: 'all' },
    },
    { domain: 'portal', allPolicies: portalResources.flatMap(resource => resource.policies) },
  )
  await portal.assignGroup('owner-1', 'business-owner', { tenantId: 'business-1' })

  for (const subjectId of ['cashier-a', 'roamer'] as const) {
    await branch.assignPolicy(subjectId, 'transaction.read', {
      tenantId: 'business-1',
      scope: 'in-branch',
    })
    await branch.assignPolicy(subjectId, 'transaction.update', {
      tenantId: 'business-1',
      scope: 'in-branch',
    })
    await branch.assignPolicy(subjectId, 'customer.read', {
      tenantId: 'business-1',
      scope: 'in-business',
    })
    await branch.assignPolicy(subjectId, 'transaction.create', {
      tenantId: 'business-1',
      scope: 'in-branch',
    })
    await branch.assignPolicy(subjectId, 'country.read', { tenantId: 'business-1' })
  }
})

afterAll(async () => {
  await close?.()
})

const asPortal = (user: string, business: string, extra: Record<string, string> = {}) => ({
  'x-user': user,
  'x-business': business,
  ...extra,
})

const asBranch = (user: string, business: string, branchId: string) => ({
  'x-user': user,
  'x-business': business,
  'x-branch': branchId,
})

async function get(path: string, headers: Record<string, string>) {
  const res = await app.inject({ method: 'GET', url: path, headers })
  return { status: res.statusCode, body: res.body === '' ? null : JSON.parse(res.body) }
}

describe('currency-exchange SAAS: the two tiers are separate apps', () => {
  test('a branch grant is not a portal grant', async () => {
    const res = await get('/portal/transactions', asPortal('cashier-a', 'business-1'))

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ACCESS_DENIED')
  })

  test('the portal never offers a branch-scoped grant — assigning one is rejected', async () => {
    await expect(
      portal.assignPolicy('owner-1', 'transaction.read', {
        tenantId: 'business-1',
        scope: 'in-branch',
      }),
    ).rejects.toThrow()
  })
})

describe('currency-exchange SAAS: branch isolation', () => {
  test('a cashier sees only the branch they are working in', async () => {
    const res = await get('/branch/transactions', asBranch('cashier-a', 'business-1', 'branch-a'))

    expect(res.status).toBe(200)
    expect(res.body).toEqual(['tx-a1'])
  })

  test('another branch of the same business is invisible', async () => {
    const res = await get('/branch/transactions', asBranch('cashier-a', 'business-1', 'branch-a'))

    expect(res.body).not.toContain('tx-b1')
  })
})

describe('currency-exchange SAAS: customers are shared across branches', () => {
  test('a customer registered at branch-b is visible from branch-a', async () => {
    const res = await get('/branch/customers', asBranch('cashier-a', 'business-1', 'branch-a'))

    expect(res.status).toBe(200)
    expect(res.body).toEqual(['cust-a', 'cust-b'])
  })

  test('another business’s customers never appear', async () => {
    const res = await get('/branch/customers', asBranch('cashier-a', 'business-1', 'branch-a'))

    expect(res.body).not.toContain('cust-x')
  })
})

describe('currency-exchange SAAS: portal-level consolidated view', () => {
  test('the business owner sees every branch’s transactions at once', async () => {
    const res = await get('/portal/transactions', asPortal('owner-1', 'business-1'))

    expect(res.status).toBe(200)
    expect(res.body).toEqual(['tx-a1', 'tx-b1'])
  })

  test('the consolidated view stops at the business boundary', async () => {
    const res = await get('/portal/transactions', asPortal('owner-1', 'business-1'))

    expect(res.body).not.toContain('tx-x1')
  })

  test('a business owner holds no grants in another business', async () => {
    const res = await get('/portal/transactions', asPortal('owner-1', 'business-2'))

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ACCESS_DENIED')
  })
})

describe('currency-exchange SAAS: global SAAS-owner data', () => {
  test('countries are unscoped — every business sees the same list', async () => {
    const res = await get('/branch/countries', asBranch('cashier-a', 'business-1', 'branch-a'))

    expect(res.status).toBe(200)
    expect(res.body).toEqual(['ae', 'pk'])
  })
})

describe('currency-exchange SAAS: one user across several branches', () => {
  test('a branch they were never invited to yields no session at all', async () => {
    const res = await get('/branch/transactions', asBranch('roamer', 'business-1', 'branch-b'))

    expect(res.status).toBe(401)
    expect(res.body.code).toBe('UNAUTHENTICATED')
  })

  test('inviting them into branch-b needs no new grant — the tenant never changed', async () => {
    await rawDb.insert(branchMembers).values([{ userId: 'roamer', branchId: 'branch-b' }])

    const atB = await get('/branch/transactions', asBranch('roamer', 'business-1', 'branch-b'))
    expect(atB.status).toBe(200)
    expect(atB.body).toEqual(['tx-b1'])
  })

  test('the same grant follows the cashier between branches, showing each in turn', async () => {
    const atA = await get('/branch/transactions', asBranch('roamer', 'business-1', 'branch-a'))
    const atB = await get('/branch/transactions', asBranch('roamer', 'business-1', 'branch-b'))

    expect(atA.body).toEqual(['tx-a1'])
    expect(atB.body).toEqual(['tx-b1'])
  })
})

describe('currency-exchange SAAS: writes carry the same grant as reads', () => {
  async function patch(path: string, headers: Record<string, string>) {
    const res = await app.inject({ method: 'PATCH', url: path, headers })
    return { status: res.statusCode, body: res.body === '' ? null : JSON.parse(res.body) }
  }

  test('a cashier may amend a trade booked at the branch they are working in', async () => {
    const res = await patch(
      '/branch/transactions/tx-a1',
      asBranch('cashier-a', 'business-1', 'branch-a'),
    )

    expect(res.status).toBe(200)
    expect(res.body.changed).toEqual(['tx-a1'])
  })

  test('amending another branch’s trade writes nothing', async () => {
    const res = await patch(
      '/branch/transactions/tx-b1',
      asBranch('cashier-a', 'business-1', 'branch-a'),
    )

    expect(res.status).toBe(200)
    expect(res.body.changed).toEqual([])
  })

  test('the grant stamps the branch on create — the handler never names it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/branch/transactions',
      headers: asBranch('cashier-a', 'business-1', 'branch-a'),
      payload: { id: 'tx-stamped', amount: '75' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).branchId).toBe('branch-a')
  })

  test('an insert naming the correct branch is accepted — the handler may write it itself', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/branch/transactions',
      headers: asBranch('cashier-a', 'business-1', 'branch-a'),
      payload: { id: 'tx-explicit', amount: '20', branchId: 'branch-a' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).branchId).toBe('branch-a')
  })

  test('an insert naming a different branch is refused, not silently corrected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/branch/transactions',
      headers: asBranch('cashier-a', 'business-1', 'branch-a'),
      payload: { id: 'tx-wrong', amount: '10', branchId: 'branch-b' },
    })

    expect(res.statusCode).toBe(500)

    const [row] = await rawDb.select().from(transactions).where(eq(transactions.id, 'tx-wrong'))
    expect(row).toBeUndefined()
  })

  test('a booked trade lands in the branch that booked it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/branch/transactions',
      headers: asBranch('cashier-a', 'business-1', 'branch-a'),
      payload: { id: 'tx-a2', amount: '450' },
    })
    expect(res.statusCode).toBe(200)

    const here = await get('/branch/transactions', asBranch('cashier-a', 'business-1', 'branch-a'))
    expect(here.body).toContain('tx-a2')

    const elsewhere = await get('/branch/transactions', asBranch('roamer', 'business-1', 'branch-b'))
    expect(elsewhere.body).not.toContain('tx-a2')
  })
})

describe('currency-exchange SAAS: business owner vs platform operator', () => {
  test('the business owner is a group, and it stops at their own business', async () => {
    const res = await get('/portal/customers', asPortal('owner-1', 'business-1'))

    expect(res.status).toBe(200)
    expect(res.body).toEqual(['cust-a', 'cust-b'])
    expect(res.body).not.toContain('cust-x')
  })

  test('a superuser holds no grants at all and still passes', async () => {
    const res = await get('/portal/customers', asPortal('saas-staff', 'business-1'))

    expect(res.status).toBe(200)
  })

  test('is_super reaches only as far as the policy declares — never another business', async () => {
    const res = await get('/portal/customers', asPortal('saas-staff', 'business-1'))

    // portal.customer.read declares in-business, so wholesale access stops there.
    expect(res.body).toEqual(['cust-a', 'cust-b'])
    expect(res.body).not.toContain('cust-x')
  })
})
