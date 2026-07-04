import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { type RequirePolicyOptions } from './require-policy.js';
import type { RbacOptions, RbacTypes } from './types.js';
import type { RbacAdapter } from './adapter.js';
import type { Subject } from './policy.js';
export interface RbacPluginOptions extends RbacOptions {
    adapter: RbacAdapter;
    db?: any;
}
type SubjectInput = Omit<Subject, 'portal'> & {
    context_id?: string;
};
export interface PortalInstance<P extends string> {
    requirePolicy: (policyName: P extends keyof RbacTypes['PortalPolicies'] ? RbacTypes['PortalPolicies'][P] : RbacTypes['PolicyName'], options?: RequirePolicyOptions) => (req: FastifyRequest, reply: any) => Promise<void>;
}
declare const _default: FastifyPluginAsync<RbacPluginOptions>;
export default _default;
declare module 'fastify' {
    interface FastifyInstance {
        rbac: {
            db: any;
            setSubject: (req: FastifyRequest, subject: Subject & {
                portal?: RbacTypes['Portal'];
            }) => void;
            forPortal: <P extends RbacTypes['Portal']>(portal: P, getSubject: (req: FastifyRequest) => SubjectInput | Promise<SubjectInput>) => PortalInstance<P>;
            addExtra: (extra: Record<string, unknown>) => void;
            clearPolicyCache: (subjectId?: string) => void;
            requirePolicy: (policyName: RbacTypes['PolicyName'], options?: RequirePolicyOptions) => (req: FastifyRequest, reply: any) => Promise<void>;
        };
    }
}
//# sourceMappingURL=plugin.d.ts.map