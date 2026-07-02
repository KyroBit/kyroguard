import type { FastifyRequest, FastifyReply } from 'fastify';
import type { RbacOptions } from './types.js';
import type { RbacAdapter } from './adapter.js';
export declare function clearPolicyCache(subjectId?: string): void;
export interface RequirePolicyOptions {
    resource?: (req: FastifyRequest) => Promise<{
        type: string;
        id: string;
    } | null | undefined> | {
        type: string;
        id: string;
    } | null | undefined;
}
export declare function requirePolicy(policyName: string, options?: RequirePolicyOptions, rbacOptions?: RbacOptions & {
    adapter: RbacAdapter;
}): (req: FastifyRequest, reply: FastifyReply) => Promise<undefined>;
//# sourceMappingURL=require-policy.d.ts.map