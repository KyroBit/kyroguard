import { createId } from '@paralleldrive/cuid2'
import {
  boolean,
  index,
  json,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

export const dialect = 'mysql' as const

// varchar(191): max indexable utf8mb4 length that keeps 4-column unique keys
// under InnoDB's 3072-byte index limit.
const id = (name: string) => varchar(name, { length: 191 })

export const kyroguardPolicies = mysqlTable('kyroguard_policies', {
  id: id('id').primaryKey().$defaultFn(() => createId()),
  name: varchar('name', { length: 191 }).notNull().unique(),
  domain: varchar('domain', { length: 191 }).notNull().default(''),
  label: varchar('label', { length: 255 }).notNull(),
  scopeOptions: json('scope_options').$type<string[]>().notNull().default([]),
  dependsOn: json('depends_on').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const kyroguardPolicyGroups = mysqlTable('kyroguard_policy_groups', {
  id: id('id').primaryKey().$defaultFn(() => createId()),
  name: varchar('name', { length: 191 }).notNull().unique(),
  label: varchar('label', { length: 255 }).notNull(),
  description: text('description'),
  isSystem: boolean('is_system').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const kyroguardPolicyGroupPolicies = mysqlTable(
  'kyroguard_policy_group_policies',
  {
    id: id('id').primaryKey().$defaultFn(() => createId()),
    policyGroupId: id('policy_group_id')
      .notNull()
      .references(() => kyroguardPolicyGroups.id),
    policyId: id('policy_id')
      .notNull()
      .references(() => kyroguardPolicies.id),
    scope: varchar('scope', { length: 191 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [uniqueIndex('kyroguard_pgp_group_policy_uq').on(table.policyGroupId, table.policyId)],
)

export const kyroguardUserPolicyGroups = mysqlTable(
  'kyroguard_user_policy_groups',
  {
    id: id('id').primaryKey().$defaultFn(() => createId()),
    subjectId: id('subject_id').notNull(),
    policyGroupId: id('policy_group_id')
      .notNull()
      .references(() => kyroguardPolicyGroups.id),
    domain: varchar('domain', { length: 191 }).notNull().default(''),
    tenantId: varchar('tenant_id', { length: 191 }).notNull().default(''),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [
    uniqueIndex('kyroguard_upg_tuple_uq').on(table.subjectId, table.policyGroupId, table.domain, table.tenantId),
    index('kyroguard_upg_subject_idx').on(table.subjectId),
  ],
)

export const kyroguardUserPolicies = mysqlTable(
  'kyroguard_user_policies',
  {
    id: id('id').primaryKey().$defaultFn(() => createId()),
    subjectId: id('subject_id').notNull(),
    policyId: id('policy_id')
      .notNull()
      .references(() => kyroguardPolicies.id),
    domain: varchar('domain', { length: 191 }).notNull().default(''),
    tenantId: varchar('tenant_id', { length: 191 }).notNull().default(''),
    scope: varchar('scope', { length: 191 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [
    uniqueIndex('kyroguard_up_tuple_uq').on(table.subjectId, table.policyId, table.domain, table.tenantId),
    index('kyroguard_up_subject_idx').on(table.subjectId),
  ],
)

export const kyroguardResourceOwners = mysqlTable(
  'kyroguard_resource_owners',
  {
    id: id('id').primaryKey().$defaultFn(() => createId()),
    resourceType: varchar('resource_type', { length: 191 }).notNull(),
    resourceId: varchar('resource_id', { length: 191 }).notNull(),
    ownerId: varchar('owner_id', { length: 191 }).notNull(),
    relation: varchar('relation', { length: 191 }).notNull().default('owner'),
    domain: varchar('domain', { length: 191 }).notNull().default(''),
    tenantId: varchar('tenant_id', { length: 191 }).notNull().default(''),
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
