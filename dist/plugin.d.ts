import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { RbacOptions } from './types.js';
export interface RbacPluginOptions extends RbacOptions {
    db: any;
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
            requirePolicy: (policyName: string, options?: {
                resource?: (req: FastifyRequest) => unknown;
            }) => (req: FastifyRequest, reply: any) => Promise<void>;
        };
    }
}
//# sourceMappingURL=plugin.d.ts.map