import type { FastifyRequest, FastifyReply } from 'fastify';
import type { RbacOptions } from './types.js';
export declare function clearPolicyCache(subjectId?: string): void;
export declare function requirePolicy(policyName: string, options?: {
    resource?: (req: FastifyRequest) => Promise<unknown> | unknown;
}, rbacOptions?: RbacOptions & {
    db: any;
}): (req: FastifyRequest, reply: FastifyReply) => Promise<undefined>;
//# sourceMappingURL=require-policy.d.ts.map