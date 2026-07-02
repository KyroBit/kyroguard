import type { FastifyRequest, FastifyReply } from 'fastify';
import type { RbacOptions } from './types.js';
import type { RbacAdapter } from './adapter.js';
export declare function clearPolicyCache(subjectId?: string): void;
export declare function requirePolicy(policyName: string, options?: {
    resource?: (req: FastifyRequest) => Promise<unknown> | unknown;
}, rbacOptions?: RbacOptions & {
    adapter: RbacAdapter;
}): (req: FastifyRequest, reply: FastifyReply) => Promise<undefined>;
//# sourceMappingURL=require-policy.d.ts.map