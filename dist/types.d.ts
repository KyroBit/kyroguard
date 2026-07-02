import type { FastifyRequest } from 'fastify';
import type { ResourceDefinition, Subject, ScopeCondition } from './policy.js';
export interface PolicyGroupDefinition {
    name: string;
    label: string;
    is_super?: boolean;
}
export interface RbacOptions {
    resources: ResourceDefinition[];
    groups?: PolicyGroupDefinition[];
    getSubject: (req: FastifyRequest) => Subject;
    scopes?: Record<string, ScopeCondition>;
    contextExtra?: (req: FastifyRequest) => Record<string, unknown>;
}
//# sourceMappingURL=types.d.ts.map