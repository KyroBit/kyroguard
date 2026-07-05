import { createId } from '@paralleldrive/cuid2'
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const dialect = 'pg' as const

export const rbacPolicies = pgTable('rbac_policies', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull().unique(),
  domain: text('domain').notNull().default(''),
  label: text('label').notNull(),
  scopeOptions: jsonb('scope_options').$type<string[]>().notNull().default([]),
  dependsOn: jsonb('depends_on').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const rbacPolicyGroups = pgTable('rbac_policy_groups', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull().unique(),
  label: text('label').notNull(),
  description: text('description'),
  isSystem: boolean('is_system').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const rbacPolicyGroupPolicies = pgTable(
  'rbac_policy_group_policies',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    policyGroupId: text('policy_group_id')
      .notNull()
      .references(() => rbacPolicyGroups.id),
    policyId: text('policy_id')
      .notNull()
      .references(() => rbacPolicies.id),
    scope: text('scope'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [uniqueIndex('rbac_pgp_group_policy_uq').on(table.policyGroupId, table.policyId)],
)

export const rbacUserPolicyGroups = pgTable(
  'rbac_user_policy_groups',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    subjectId: text('subject_id').notNull(),
    policyGroupId: text('policy_group_id')
      .notNull()
      .references(() => rbacPolicyGroups.id),
    domain: text('domain').notNull().default(''),
    tenantId: text('tenant_id').notNull().default(''),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [
    uniqueIndex('rbac_upg_tuple_uq').on(table.subjectId, table.policyGroupId, table.domain, table.tenantId),
    index('rbac_upg_subject_idx').on(table.subjectId),
  ],
)

export const rbacUserPolicies = pgTable(
  'rbac_user_policies',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    subjectId: text('subject_id').notNull(),
    policyId: text('policy_id')
      .notNull()
      .references(() => rbacPolicies.id),
    domain: text('domain').notNull().default(''),
    tenantId: text('tenant_id').notNull().default(''),
    scope: text('scope'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [
    uniqueIndex('rbac_up_tuple_uq').on(table.subjectId, table.policyId, table.domain, table.tenantId),
    index('rbac_up_subject_idx').on(table.subjectId),
  ],
)

export const rbacResourceOwners = pgTable(
  'rbac_resource_owners',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    ownerId: text('owner_id').notNull(),
    domain: text('domain').notNull().default(''),
    tenantId: text('tenant_id').notNull().default(''),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [
    uniqueIndex('rbac_ro_tuple_uq').on(table.resourceType, table.resourceId, table.ownerId),
    index('rbac_ro_resource_idx').on(table.resourceType, table.resourceId),
  ],
)

export const tables = {
  policies: rbacPolicies,
  policyGroups: rbacPolicyGroups,
  policyGroupPolicies: rbacPolicyGroupPolicies,
  userPolicyGroups: rbacUserPolicyGroups,
  userPolicies: rbacUserPolicies,
  resourceOwners: rbacResourceOwners,
} as const
