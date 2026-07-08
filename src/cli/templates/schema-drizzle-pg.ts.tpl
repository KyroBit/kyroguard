// The kyroguard tables for @kyrobit/kyroguard (drizzle, pg) — mirrors @kyrobit/kyroguard/drizzle/schema/pg.
// Add this file to your drizzle-kit schema paths and migrate before `kyroguard sync`.
import { createId } from '@kyrobit/kyroguard'
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

export const kyroguardPolicies = pgTable('kyroguard_policies', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull().unique(),
  domain: text('domain').notNull().default(''),
  label: text('label').notNull(),
  scopeOptions: jsonb('scope_options').$type<string[]>().notNull().default([]),
  dependsOn: jsonb('depends_on').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const kyroguardPolicyGroups = pgTable('kyroguard_policy_groups', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull().unique(),
  label: text('label').notNull(),
  description: text('description'),
  isSystem: boolean('is_system').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const kyroguardPolicyGroupPolicies = pgTable(
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
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [uniqueIndex('kyroguard_pgp_group_policy_uq').on(table.policyGroupId, table.policyId)],
)

export const kyroguardUserPolicyGroups = pgTable(
  'kyroguard_user_policy_groups',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    subjectId: text('subject_id').notNull(),
    policyGroupId: text('policy_group_id')
      .notNull()
      .references(() => kyroguardPolicyGroups.id),
    domain: text('domain').notNull().default(''),
    tenantId: text('tenant_id').notNull().default(''),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [
    uniqueIndex('kyroguard_upg_tuple_uq').on(table.subjectId, table.policyGroupId, table.domain, table.tenantId),
    index('kyroguard_upg_subject_idx').on(table.subjectId),
  ],
)

export const kyroguardUserPolicies = pgTable(
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
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [
    uniqueIndex('kyroguard_up_tuple_uq').on(table.subjectId, table.policyId, table.domain, table.tenantId),
    index('kyroguard_up_subject_idx').on(table.subjectId),
  ],
)

export const kyroguardResourceOwners = pgTable(
  'kyroguard_resource_owners',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    ownerId: text('owner_id').notNull(),
    relation: text('relation').notNull().default('owner'),
    domain: text('domain').notNull().default(''),
    tenantId: text('tenant_id').notNull().default(''),
    createdAt: timestamp('created_at').notNull().defaultNow(),
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
