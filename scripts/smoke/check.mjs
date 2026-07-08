// Runs inside the smoke fixture against the INSTALLED tarball.
// Exercises: root export, /testing, /fastify, /express subpaths; ALS
// propagation under Node; 401/403/200 decisions end to end.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'

import { createGuard } from '@kyrobit/kyroguard'
import { memoryAdapter } from '@kyrobit/kyroguard/testing'
import { kyroguardFastify } from '@kyrobit/kyroguard/fastify'
import { kyroguardExpress } from '@kyrobit/kyroguard/express'
import Fastify from 'fastify'
import express from 'express'

async function seededGuard() {
  const adapter = memoryAdapter()
  await adapter.upsertPolicies([
    { name: 'admin.posts.read', domain: 'admin', label: 'Read posts', scopeOptions: [], dependsOn: [] },
  ])
  await adapter.upsertGroup({ name: 'editors', label: 'Editors' })
  await adapter.setGroupPolicies('editors', [{ policyName: 'admin.posts.read', scope: null }])
  await adapter.assignGroup({ subjectId: 'u1', domain: 'admin', tenantId: '' }, 'editors')
  return createGuard({ adapter })
}

// ── Fastify ───────────────────────────────────────────────────────────────────
{
  const guard = await seededGuard()
  const app = Fastify()
  await app.register(kyroguardFastify(guard))
  const admin = app.kyroguard.domain('admin', {
    getSubject: req => (req.headers['x-user-id'] ? { id: String(req.headers['x-user-id']) } : null),
  })
  app.get('/posts', { preHandler: admin.requirePolicy('posts.read') }, async () => ({ ok: true }))

  const allowed = await app.inject({ method: 'GET', url: '/posts', headers: { 'x-user-id': 'u1' } })
  assert.equal(allowed.statusCode, 200, `fastify allow: ${allowed.statusCode} ${allowed.body}`)

  const denied = await app.inject({ method: 'GET', url: '/posts', headers: { 'x-user-id': 'u2' } })
  assert.equal(denied.statusCode, 403, `fastify deny: ${denied.statusCode}`)
  const deniedBody = JSON.parse(denied.body)
  assert.equal(deniedBody.code, 'ACCESS_DENIED')
  // Fastify's default serializer carries code but not reason (see docs/reference/errors.md).
  assert.equal(deniedBody.reason, undefined)

  const anonymous = await app.inject({ method: 'GET', url: '/posts' })
  assert.equal(anonymous.statusCode, 401, `fastify anon: ${anonymous.statusCode}`)

  await app.close()
  guard.dispose()
  console.log('[smoke] fastify: 200/403/401 OK')
}

// ── Express ───────────────────────────────────────────────────────────────────
{
  const guard = await seededGuard()
  const { context, domain, errorHandler } = kyroguardExpress(guard)
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
  const deniedBody = await denied.json()
  assert.equal(deniedBody.code, 'ACCESS_DENIED')
  assert.equal(deniedBody.reason, 'policy')

  const anonymous = await fetch(`${base}/posts`)
  assert.equal(anonymous.status, 401, `express anon: ${anonymous.status}`)

  server.close()
  guard.dispose()
  console.log('[smoke] express: 200/403/401 OK')
}

console.log('[smoke] check.mjs passed')
