/// <reference types="bun-types" />
/**
 * Fresh in-memory SQLite database for drizzle adapter tests.
 *
 * The DDL below mirrors src/storage/drizzle/schema/sqlite.ts exactly:
 *   - text primary keys (cuid2 generated at runtime via $defaultFn — no SQL default)
 *   - integer booleans (mode: 'boolean') with DDL defaults 0 / 1
 *   - text json columns (mode: 'json') with DEFAULT '[]'
 *   - NOT NULL DEFAULT '' sentinel columns for domain / tenant_id
 *   - integer timestamps (mode: 'timestamp'), NOT NULL, populated at runtime
 *   - the same unique + plain indexes the drizzle schema declares
 */

import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

const DDL = `
CREATE TABLE kyroguard_policies (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  domain text NOT NULL DEFAULT '',
  label text NOT NULL,
  scope_options text NOT NULL DEFAULT '[]',
  depends_on text NOT NULL DEFAULT '[]',
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX kyroguard_policies_name_unique ON kyroguard_policies (name);

CREATE TABLE kyroguard_policy_groups (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  label text NOT NULL,
  description text,
  is_system integer NOT NULL DEFAULT 0,
  is_active integer NOT NULL DEFAULT 1,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX kyroguard_policy_groups_name_unique ON kyroguard_policy_groups (name);

CREATE TABLE kyroguard_policy_group_policies (
  id text PRIMARY KEY NOT NULL,
  policy_group_id text NOT NULL REFERENCES kyroguard_policy_groups(id),
  policy_id text NOT NULL REFERENCES kyroguard_policies(id),
  scope text,
  created_at integer NOT NULL
);
CREATE UNIQUE INDEX kyroguard_pgp_group_policy_uq ON kyroguard_policy_group_policies (policy_group_id, policy_id);

CREATE TABLE kyroguard_user_policy_groups (
  id text PRIMARY KEY NOT NULL,
  subject_id text NOT NULL,
  policy_group_id text NOT NULL REFERENCES kyroguard_policy_groups(id),
  domain text NOT NULL DEFAULT '',
  tenant_id text NOT NULL DEFAULT '',
  created_at integer NOT NULL
);
CREATE UNIQUE INDEX kyroguard_upg_tuple_uq ON kyroguard_user_policy_groups (subject_id, policy_group_id, domain, tenant_id);
CREATE INDEX kyroguard_upg_subject_idx ON kyroguard_user_policy_groups (subject_id);

CREATE TABLE kyroguard_user_policies (
  id text PRIMARY KEY NOT NULL,
  subject_id text NOT NULL,
  policy_id text NOT NULL REFERENCES kyroguard_policies(id),
  domain text NOT NULL DEFAULT '',
  tenant_id text NOT NULL DEFAULT '',
  scope text,
  created_at integer NOT NULL
);
CREATE UNIQUE INDEX kyroguard_up_tuple_uq ON kyroguard_user_policies (subject_id, policy_id, domain, tenant_id);
CREATE INDEX kyroguard_up_subject_idx ON kyroguard_user_policies (subject_id);

CREATE TABLE kyroguard_resource_owners (
  id text PRIMARY KEY NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  owner_id text NOT NULL,
  relation text NOT NULL DEFAULT 'owner',
  domain text NOT NULL DEFAULT '',
  tenant_id text NOT NULL DEFAULT '',
  created_at integer NOT NULL
);
CREATE UNIQUE INDEX kyroguard_ro_tuple_uq ON kyroguard_resource_owners (resource_type, resource_id, owner_id, relation);
CREATE INDEX kyroguard_ro_resource_idx ON kyroguard_resource_owners (resource_type, resource_id);
CREATE INDEX kyroguard_ro_owner_idx ON kyroguard_resource_owners (resource_type, owner_id);
`

export interface SqliteTestDb {
  db: BunSQLiteDatabase
  sqlite: Database
}

/**
 * Fresh, fully-migrated in-memory database per call — no shared state.
 * `extraDdl` lets a test add its own user tables (docs, ...) up front.
 */
export function makeSqliteDb(extraDdl?: string): SqliteTestDb {
  const sqlite = new Database(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  sqlite.exec(DDL)
  if (extraDdl) sqlite.exec(extraDdl)
  const db = drizzle(sqlite)
  return { db, sqlite }
}
