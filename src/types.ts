import type { SQL }              from 'drizzle-orm'
import type { FastifyRequest }   from 'fastify'
import type { ResourceDefinition, Subject, ScopeCondition } from './policy.js'

export interface RbacOptions {
  resources:     ResourceDefinition[]
  getSubject:    (req: FastifyRequest) => Subject
  scopes?:       Record<string, ScopeCondition>
  contextExtra?: (req: FastifyRequest) => Record<string, unknown>
}
