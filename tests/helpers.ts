import Fastify, { type FastifyInstance } from 'fastify'
import rbacPlugin                       from '../src/plugin.js'
import { clearPolicyCache }             from '../src/require-policy.js'
import { Scope }                        from '../src/scope.js'
import type { RbacAdapter, PolicyRow, PolicyRecord, GroupPolicyRecord, GroupPolicyInsert } from '../src/adapter.js'

// ─── Mock adapter ─────────────────────────────────────────────────────────────

export type SeedRow = {
  subjectId: string
  portal:    string | null
  contextId: string | null
  policies:  { name: string; scope: string | null }[]
}

export function createMockAdapter() {
  const groupRows:  SeedRow[]                                           = []
  const directRows: { subjectId: string; name: string; scope: string | null }[] = []

  const adapter: RbacAdapter = {
    async upsertPolicies(_rows: PolicyRow[]) {},
    async listAllPolicies(): Promise<PolicyRecord[]> { return [] },
    async deleteGroupPolicies(_ids: string[]) {},
    async deleteUserPolicies(_ids: string[]) {},
    async deletePolicies(_ids: string[]) {},
    async listGroups() { return [] },
    async getGroupPolicies(_id: string): Promise<GroupPolicyRecord[]> { return [] },
    async insertGroupPolicies(_rows: GroupPolicyInsert[]) {},

    // Strict matching — mirrors drizzle-adapter behaviour exactly
    async getSubjectGroupPolicies(subjectId, portal, contextId) {
      const p = portal    ?? null
      const c = contextId ?? null
      return groupRows
        .filter(r => r.subjectId === subjectId && r.portal === p && r.contextId === c)
        .flatMap(r => r.policies)
    },

    async getSubjectDirectPolicies(subjectId) {
      return directRows.filter(r => r.subjectId === subjectId).map(r => ({ name: r.name, scope: r.scope }))
    },
  }

  return {
    adapter,
    /** Seed a group-membership row (portal+context strict match). */
    seed(row: SeedRow) { groupRows.push(row) },
    /** Seed a direct-assignment row (no portal/context filter). */
    seedDirect(subjectId: string, name: string, scope: string | null = null) {
      directRows.push({ subjectId, name, scope })
    },
    /** Clear all assignments and the in-process policy cache. */
    reset() {
      groupRows.length  = 0
      directRows.length = 0
      clearPolicyCache()
    },
  }
}

export type TestAdapter = ReturnType<typeof createMockAdapter>

// ─── App factory ──────────────────────────────────────────────────────────────

export type RouteSpec = {
  method?:      'GET' | 'POST' | 'PUT' | 'DELETE'
  path:         string
  policy:       string
  withResource?: boolean          // pass a dummy resource resolver for scope tests
  resourceNull?: boolean          // resource resolver returns null (404 path)
}

/**
 * Builds a Fastify app pre-loaded with the RBAC plugin and `forPortal`.
 * Subject is resolved from request headers so each test can vary it freely.
 */
export async function buildApp(
  mock:   TestAdapter,
  portal: string,
  routes: RouteSpec[],
  db?:    any,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  await app.register(rbacPlugin, { adapter: mock.adapter, db })

  const rbac = app.rbac.forPortal(portal as any, (req) => ({
    id:        (req.headers['x-user-id'] as string) ?? '',
    context_id: (req.headers['x-context-id'] as string) || undefined,
    is_super:   req.headers['x-is-super'] === 'true',
  }))

  for (const r of routes) {
    app.route({
      method:  r.method ?? 'GET',
      url:     r.path,
      preHandler: rbac.requirePolicy(r.policy as any, r.withResource || r.resourceNull ? {
        resource: r.resourceNull
          ? () => null
          : () => ({ type: 'post', id: 'resource-id' }),
      } : undefined),
      handler: async () => ({ ok: true }),
    })
  }

  await app.ready()
  return app
}

// ─── Inject helper ────────────────────────────────────────────────────────────

export function req(app: FastifyInstance, opts: {
  url:       string
  userId?:   string
  contextId?: string
  isSuper?:  boolean
  method?:   'GET' | 'POST' | 'PUT' | 'DELETE'
}) {
  return app.inject({
    method: opts.method ?? 'GET',
    url:    opts.url,
    headers: {
      ...(opts.userId    ? { 'x-user-id':    opts.userId    } : {}),
      ...(opts.contextId ? { 'x-context-id': opts.contextId } : {}),
      ...(opts.isSuper   ? { 'x-is-super':   'true'         } : {}),
    },
  })
}

// ─── Scope helpers ────────────────────────────────────────────────────────────

export const allowScope = new Scope('allow-scope', 'Allow', () => true)
export const denyScope  = new Scope('deny-scope',  'Deny',  () => false)
