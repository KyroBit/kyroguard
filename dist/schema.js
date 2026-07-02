import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';
export const policies = pgTable('rbac_policies', {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    name: text('name').notNull().unique(),
    label: text('label').notNull(),
    depends_on: jsonb('depends_on').$type().notNull().default([]),
    created_at: timestamp('created_at').defaultNow().notNull(),
    updated_at: timestamp('updated_at').defaultNow().notNull(),
});
export const policyGroups = pgTable('rbac_policy_groups', {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    name: text('name').notNull().unique(),
    label: text('label').notNull(),
    description: text('description'),
    is_system: text('is_system').notNull().default('false'),
    is_active: text('is_active').notNull().default('true'),
    created_at: timestamp('created_at').defaultNow().notNull(),
    updated_at: timestamp('updated_at').defaultNow().notNull(),
});
const restrict = { onDelete: 'restrict', onUpdate: 'restrict' };
export const policyGroupPolicies = pgTable('rbac_policy_group_policies', {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    policy_group_id: text('policy_group_id').notNull().references(() => policyGroups.id, restrict),
    policy_id: text('policy_id').notNull().references(() => policies.id, restrict),
    scope: text('scope'),
    created_at: timestamp('created_at').defaultNow().notNull(),
});
export const userPolicyGroups = pgTable('rbac_user_policy_groups', {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    subject_id: text('subject_id').notNull(),
    policy_group_id: text('policy_group_id').notNull().references(() => policyGroups.id, restrict),
    created_at: timestamp('created_at').defaultNow().notNull(),
});
export const userPolicies = pgTable('rbac_user_policies', {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    subject_id: text('subject_id').notNull(),
    policy_id: text('policy_id').notNull().references(() => policies.id, restrict),
    scope: text('scope'),
    created_at: timestamp('created_at').defaultNow().notNull(),
});
export const resourceOwners = pgTable('rbac_resource_owners', {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    resource_type: text('resource_type').notNull(),
    resource_id: text('resource_id').notNull(),
    subject_id: text('subject_id'),
    context_type: text('context_type'),
    context_id: text('context_id'),
    meta: jsonb('meta').$type(),
    created_at: timestamp('created_at').defaultNow().notNull(),
});
//# sourceMappingURL=schema.js.map