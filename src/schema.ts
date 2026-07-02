import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'

export const policies = pgTable('rbac_policies', {
  id:         text('id').primaryKey().$defaultFn(() => createId()),
  name:       text('name').notNull().unique(),
  label:      text('label').notNull(),
  depends_on: jsonb('depends_on').$type<string[]>().notNull().default([]),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
})

export const policyGroups = pgTable('rbac_policy_groups', {
  id:          text('id').primaryKey().$defaultFn(() => createId()),
  name:        text('name').notNull().unique(),
  description: text('description'),
  is_system:   text('is_system').notNull().default('false'),
  is_super:    text('is_super').notNull().default('false'),  // bypasses all checks
  is_active:   text('is_active').notNull().default('true'),
  created_at:  timestamp('created_at').defaultNow().notNull(),
  updated_at:  timestamp('updated_at').defaultNow().notNull(),
})

export const policyGroupPolicies = pgTable('rbac_policy_group_policies', {
  id:              text('id').primaryKey().$defaultFn(() => createId()),
  policy_group_id: text('policy_group_id').notNull().references(() => policyGroups.id, { onDelete: 'cascade' }),
  policy_id:       text('policy_id').notNull().references(() => policies.id,       { onDelete: 'cascade' }),
  scope:           text('scope'),   // consumer-defined scope name e.g. 'BranchOwned' — nullable = all
  created_at:      timestamp('created_at').defaultNow().notNull(),
})

export const resourceOwners = pgTable('rbac_resource_owners', {
  id:            text('id').primaryKey().$defaultFn(() => createId()),
  resource_type: text('resource_type').notNull(),  // e.g. 'blog'
  resource_id:   text('resource_id').notNull(),
  subject_id:    text('subject_id'),               // who created it (null = system)
  context_type:  text('context_type'),             // e.g. 'BRANCH', 'ADMIN'
  context_id:    text('context_id'),               // e.g. branch_id
  meta:          jsonb('meta').$type<Record<string, unknown>>(),
  created_at:    timestamp('created_at').defaultNow().notNull(),
})
