import type { RbacOptions } from './types.js';
import type { FastifyRequest } from 'fastify';
export interface RbacPluginOptions extends RbacOptions {
    db: any;
    policyGroupIdField?: string;
}
declare const _default: any;
export default _default;
declare module 'fastify' {
    interface FastifyInstance {
        rbac: {
            db: any;
            setContext: (req: FastifyRequest, context: string) => void;
            addExtra: (extra: Record<string, unknown>) => void;
            clearPolicyCache: (policyGroupId?: string) => void;
            requirePolicy: (policyName: string, options?: {
                resource?: (req: FastifyRequest) => unknown;
            }) => (req: FastifyRequest, reply: any) => Promise<void>;
        };
    }
}
//# sourceMappingURL=plugin.d.ts.map