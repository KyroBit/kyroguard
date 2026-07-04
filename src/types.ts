import type { FastifyRequest }   from 'fastify'
import type { ScopeCondition } from './policy.js'


// Override this interface in your project via module augmentation (rbac.d.ts)
// to get typed Portal names, PolicyName autocomplete, and per-portal policy narrowing.
export interface RbacTypes {
  Portal:         string
  PolicyName:     string
  PortalPolicies: Record<string, string>
}

export interface PolicyGroupDefinition {
  name:     string
  label:    string
  is_super?: boolean
}

export interface RbacOptions {
  groups?:       PolicyGroupDefinition[]
  queryScopes?:  Record<string, ScopeCondition>
  contextExtra?: (req: FastifyRequest) => Record<string, unknown>
}
