import type { FastifyRequest, FastifyReply } from 'fastify';
import type { RbacOptions } from './types.js';
export declare function clearPolicyCache(policyGroupId?: string): void;
export declare function requirePolicy(policyName: string, options?: {
    resource?: (req: FastifyRequest) => Promise<unknown> | unknown;
}, rbacOptions?: RbacOptions & {
    db: any;
    policyGroupIdFromReq: (req: FastifyRequest) => Promise<string | null>;
}): (req: FastifyRequest, reply: FastifyReply) => Promise<any>;
//# sourceMappingURL=require-policy.d.ts.map