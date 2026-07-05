import { createId } from '@paralleldrive/cuid2'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const dialect = 'sqlite' as const

const timestampCol = (name: string) =>
  integer(name, { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())

export const rbacPolicies = sqliteTable('rbac_policies', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull().unique(),
  domain: text('domain').notNull().default(''),
  label: text('label').notNull(),
  scopeOptions: text('scope_options', { mode: 'json' }).$type<string[]>().notNull().default([]),
  dependsOn: text('depends_on', { mode: 'json' }).$type<string[]>().notNull().default([]),
  createdAt: timestampCol('created_at'),
  updatedAt: timestampCol('updated_at'),
})

export const rbacPolicyGroups = sqliteTable('rbac_policy_groups', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull().unique(),
  label: text('label').notNull(),
  description: text('description'),
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: timestampCol('created_at'),
  updatedAt: timestampCol('updated_at'),
})

export const rbacPolicyGroupPolicies = sqliteTable(
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
    createdAt: timestampCol('created_at'),
  },
  table => [uniqueIndex('rbac_pgp_group_policy_uq').on(table.policyGroupId, table.policyId)],
)

export const rbacUserPolicyGroups = sqliteTable(
  'rbac_user_policy_groups',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    subjectId: text('subject_id').notNull(),
    policyGroupId: text('policy_group_id')
      .notNull()
      .references(() => rbacPolicyGroups.id),
    domain: text('domain').notNull().default(''),
    tenantId: text('tenant_id').notNull().default(''),
    createdAt: timestampCol('created_at'),
  },
  table => [
    uniqueIndex('rbac_upg_tuple_uq').on(table.subjectId, table.policyGroupId, table.domain, table.tenantId),
    index('rbac_upg_subject_idx').on(table.subjectId),
  ],
)

export const rbacUserPolicies = sqliteTable(
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
    createdAt: timestampCol('created_at'),
  },
  table => [
    uniqueIndex('rbac_up_tuple_uq').on(table.subjectId, table.policyId, table.domain, table.tenantId),
    index('rbac_up_subject_idx').on(table.subjectId),
  ],
)

export const rbacResourceOwners = sqliteTable(
  'rbac_resource_owners',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    ownerId: text('owner_id').notNull(),
    relation: text('relation').notNull().default('owner'),
    domain: text('domain').notNull().default(''),
    tenantId: text('tenant_id').notNull().default(''),
    createdAt: timestampCol('created_at'),
  },
  table => [
    uniqueIndex('rbac_ro_tuple_uq').on(table.resourceType, table.resourceId, table.ownerId, table.relation),
    index('rbac_ro_resource_idx').on(table.resourceType, table.resourceId),
    index('rbac_ro_owner_idx').on(table.resourceType, table.ownerId),
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
