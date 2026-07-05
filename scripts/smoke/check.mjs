// Runs inside the smoke fixture against the INSTALLED tarball.
// Exercises: root export, /testing, /fastify, /express subpaths; ALS
// propagation under Node; 401/403/200 decisions end to end.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'

import { createRbac } from '@kyrobit/rbac'
import { memoryAdapter } from '@kyrobit/rbac/testing'
import { rbacFastify } from '@kyrobit/rbac/fastify'
import { rbacExpress } from '@kyrobit/rbac/express'
import Fastify from 'fastify'
import express from 'express'

async function seededRbac() {
  const adapter = memoryAdapter()
  await adapter.upsertPolicies([
    { name: 'admin.posts.read', domain: 'admin', label: 'Read posts', scopeOptions: [], dependsOn: [] },
  ])
  await adapter.upsertGroup({ name: 'editors', label: 'Editors' })
  await adapter.setGroupPolicies('editors', [{ policyName: 'admin.posts.read', scope: null }])
  await adapter.assignGroup({ subjectId: 'u1', domain: 'admin', tenantId: '' }, 'editors')
  return createRbac({ adapter })
}

// ── Fastify ───────────────────────────────────────────────────────────────────
{
  const rbac = await seededRbac()
  const app = Fastify()
  await app.register(rbacFastify(rbac))
  const admin = app.rbac.domain('admin', {
    getSubject: req => (req.headers['x-user-id'] ? { id: String(req.headers['x-user-id']) } : null),
  })
  app.get('/posts', { preHandler: admin.requirePolicy('posts.read') }, async () => ({ ok: true }))

  const allowed = await app.inject({ method: 'GET', url: '/posts', headers: { 'x-user-id': 'u1' } })
  assert.equal(allowed.statusCode, 200, `fastify allow: ${allowed.statusCode} ${allowed.body}`)

  const denied = await app.inject({ method: 'GET', url: '/posts', headers: { 'x-user-id': 'u2' } })
  assert.equal(denied.statusCode, 403, `fastify deny: ${denied.statusCode}`)
  assert.equal(JSON.parse(denied.body).code, 'RBAC_POLICY_DENIED')

  const anonymous = await app.inject({ method: 'GET', url: '/posts' })
  assert.equal(anonymous.statusCode, 401, `fastify anon: ${anonymous.statusCode}`)

  await app.close()
  rbac.dispose()
  console.log('[smoke] fastify: 200/403/401 OK')
}

// ── Express ───────────────────────────────────────────────────────────────────
{
  const rbac = await seededRbac()
  const { context, domain, errorHandler } = rbacExpress(rbac)
  const app = express()
  app.use(context())
  const admin = domain('admin', {
    getSubject: req => (req.headers['x-user-id'] ? { id: String(req.headers['x-user-id']) } : null),
  })
  app.get('/posts', admin.requirePolicy('posts.read'), (_req, res) => res.json({ ok: true }))
  app.use(errorHandler())

  const server = createServer(app)
  server.listen(0)
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`

  const allowed = await fetch(`${base}/posts`, { headers: { 'x-user-id': 'u1' } })
  assert.equal(allowed.status, 200, `express allow: ${allowed.status}`)

  const denied = await fetch(`${base}/posts`, { headers: { 'x-user-id': 'u2' } })
  assert.equal(denied.status, 403, `express deny: ${denied.status}`)
  assert.equal((await denied.json()).code, 'RBAC_POLICY_DENIED')

  const anonymous = await fetch(`${base}/posts`)
  assert.equal(anonymous.status, 401, `express anon: ${anonymous.status}`)

  server.close()
  rbac.dispose()
  console.log('[smoke] express: 200/403/401 OK')
}

console.log('[smoke] check.mjs passed')
