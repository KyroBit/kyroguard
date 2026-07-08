import { createId } from '@paralleldrive/cuid2'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const dialect = 'sqlite' as const

const timestampCol = (name: string) =>
  integer(name, { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date())

export const kyroguardPolicies = sqliteTable('kyroguard_policies', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull().unique(),
  domain: text('domain').notNull().default(''),
  label: text('label').notNull(),
  scopeOptions: text('scope_options', { mode: 'json' }).$type<string[]>().notNull().default([]),
  dependsOn: text('depends_on', { mode: 'json' }).$type<string[]>().notNull().default([]),
  createdAt: timestampCol('created_at'),
  updatedAt: timestampCol('updated_at'),
})

export const kyroguardPolicyGroups = sqliteTable('kyroguard_policy_groups', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull().unique(),
  label: text('label').notNull(),
  description: text('description'),
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: timestampCol('created_at'),
  updatedAt: timestampCol('updated_at'),
})

export const kyroguardPolicyGroupPolicies = sqliteTable(
  'kyroguard_policy_group_policies',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    policyGroupId: text('policy_group_id')
      .notNull()
      .references(() => kyroguardPolicyGroups.id),
    policyId: text('policy_id')
      .notNull()
      .references(() => kyroguardPolicies.id),
    scope: text('scope'),
    createdAt: timestampCol('created_at'),
  },
  table => [uniqueIndex('kyroguard_pgp_group_policy_uq').on(table.policyGroupId, table.policyId)],
)

export const kyroguardUserPolicyGroups = sqliteTable(
  'kyroguard_user_policy_groups',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    subjectId: text('subject_id').notNull(),
    policyGroupId: text('policy_group_id')
      .notNull()
      .references(() => kyroguardPolicyGroups.id),
    domain: text('domain').notNull().default(''),
    tenantId: text('tenant_id').notNull().default(''),
    createdAt: timestampCol('created_at'),
  },
  table => [
    uniqueIndex('kyroguard_upg_tuple_uq').on(table.subjectId, table.policyGroupId, table.domain, table.tenantId),
    index('kyroguard_upg_subject_idx').on(table.subjectId),
  ],
)

export const kyroguardUserPolicies = sqliteTable(
  'kyroguard_user_policies',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    subjectId: text('subject_id').notNull(),
    policyId: text('policy_id')
      .notNull()
      .references(() => kyroguardPolicies.id),
    domain: text('domain').notNull().default(''),
    tenantId: text('tenant_id').notNull().default(''),
    scope: text('scope'),
    createdAt: timestampCol('created_at'),
  },
  table => [
    uniqueIndex('kyroguard_up_tuple_uq').on(table.subjectId, table.policyId, table.domain, table.tenantId),
    index('kyroguard_up_subject_idx').on(table.subjectId),
  ],
)

export const kyroguardResourceOwners = sqliteTable(
  'kyroguard_resource_owners',
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
    uniqueIndex('kyroguard_ro_tuple_uq').on(table.resourceType, table.resourceId, table.ownerId, table.relation),
    index('kyroguard_ro_resource_idx').on(table.resourceType, table.resourceId),
    index('kyroguard_ro_owner_idx').on(table.resourceType, table.ownerId),
  ],
)

export const tables = {
  policies: kyroguardPolicies,
  policyGroups: kyroguardPolicyGroups,
  policyGroupPolicies: kyroguardPolicyGroupPolicies,
  userPolicyGroups: kyroguardUserPolicyGroups,
  userPolicies: kyroguardUserPolicies,
  resourceOwners: kyroguardResourceOwners,
} as const
