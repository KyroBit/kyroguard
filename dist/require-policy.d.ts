import type { FastifyRequest, FastifyReply } from 'fastify';
import type { RbacOptions, RbacTypes } from './types.js';
import type { RbacAdapter } from './adapter.js';
import type { Scope } from './scope.js';
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
export declare function requirePolicy(policyName: RbacTypes['PolicyName'], options?: RequirePolicyOptions, rbacOptions?: RbacOptions & {
    adapter: RbacAdapter;
    scopes?: Scope[];
}): (req: FastifyRequest, reply: FastifyReply) => Promise<undefined>;
//# sourceMappingURL=require-policy.d.ts.map