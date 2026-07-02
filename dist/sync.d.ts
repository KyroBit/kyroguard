import type { Policy } from './policy.js';
import type { RbacAdapter } from './adapter.js';
export interface ResourceDefinition {
    policies: Policy[];
}
export declare function syncPolicies(adapter: RbacAdapter, resources: ResourceDefinition[]): Promise<void>;
//# sourceMappingURL=sync.d.ts.map