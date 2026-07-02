import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { type RequirePolicyOptions } from './require-policy.js';
import type { RbacOptions } from './types.js';
import type { RbacAdapter } from './adapter.js';
export interface RbacPluginOptions extends RbacOptions {
    adapter: RbacAdapter;
    db?: any;
}
declare const _default: FastifyPluginAsync<RbacPluginOptions>;
export default _default;
declare module 'fastify' {
    interface FastifyInstance {
        rbac: {
            db: any;
            setContext: (req: FastifyRequest, context: string) => void;
            addExtra: (extra: Record<string, unknown>) => void;
            clearPolicyCache: (subjectId?: string) => void;
            requirePolicy: (policyName: string, options?: RequirePolicyOptions) => (req: FastifyRequest, reply: any) => Promise<void>;
        };
    }
}
//# sourceMappingURL=plugin.d.ts.map