export { Policy } from './policy.js';
export type { ResourceDefinition, Subject, ScopeCondition, ContextPolicies } from './policy.js';
export { Scope } from './scope.js';
export type { ScopeCheckFn } from './scope.js';
export type { RbacOptions, RbacTypes } from './types.js';
export type { RbacAdapter } from './adapter.js';
export { createDrizzleAdapter } from './drizzle-adapter.js';
export { syncPolicies } from './sync.js';
export { clearPolicyCache } from './require-policy.js';
export { addExtra, setContext } from './store.js';
export { policies, policyGroups, policyGroupPolicies, userPolicyGroups, userPolicies, } from './schema.js';
export { default as rbacPlugin } from './plugin.js';
export type { RbacPluginOptions } from './plugin.js';
export { seedGroups } from './seed-groups.js';
export type { GroupDefinition, GroupsDefinition, GroupPoliciesInput } from './seed-groups.js';
export { assignGroup, removeGroup, assignPolicy, removePolicy } from './assign.js';
//# sourceMappingURL=index.d.ts.map