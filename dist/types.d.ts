import type { FastifyRequest } from 'fastify';
import type { ResourceDefinition, ScopeCondition } from './policy.js';
export interface RbacTypes {
    Portal: string;
    PolicyName: string;
    PortalPolicies: Record<string, string>;
}
export interface PolicyGroupDefinition {
    name: string;
    label: string;
    is_super?: boolean;
}
export interface RbacOptions {
    resources: ResourceDefinition[];
    groups?: PolicyGroupDefinition[];
    queryScopes?: Record<string, ScopeCondition>;
    contextExtra?: (req: FastifyRequest) => Record<string, unknown>;
}
//# sourceMappingURL=types.d.ts.map