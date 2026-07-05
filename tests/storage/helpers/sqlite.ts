/// <reference types="bun-types" />
/**
 * Fresh in-memory SQLite database for drizzle adapter tests.
 *
 * The DDL below mirrors src/storage/drizzle/schema/sqlite.ts exactly:
 *   - text primary keys (cuid2 generated at runtime via $defaultFn — no SQL default)
 *   - integer booleans (mode: 'boolean') with DDL defaults 0 / 1
 *   - text json columns (mode: 'json') with DEFAULT '[]'
 *   - NOT NULL DEFAULT '' sentinel columns for portal / context_id / context_type
 *   - integer timestamps (mode: 'timestamp'), NOT NULL, populated at runtime
 *   - the same unique + plain indexes the drizzle schema declares
 */

import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

const DDL = `
CREATE TABLE rbac_policies (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  portal text NOT NULL DEFAULT '',
  label text NOT NULL,
  scope_options text NOT NULL DEFAULT '[]',
  depends_on text NOT NULL DEFAULT '[]',
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX rbac_policies_name_unique ON rbac_policies (name);

CREATE TABLE rbac_policy_groups (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  label text NOT NULL,
  description text,
  is_system integer NOT NULL DEFAULT 0,
  is_active integer NOT NULL DEFAULT 1,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX rbac_policy_groups_name_unique ON rbac_policy_groups (name);

CREATE TABLE rbac_policy_group_policies (
  id text PRIMARY KEY NOT NULL,
  policy_group_id text NOT NULL REFERENCES rbac_policy_groups(id),
  policy_id text NOT NULL REFERENCES rbac_policies(id),
  scope text,
  created_at integer NOT NULL
);
CREATE UNIQUE INDEX rbac_pgp_group_policy_uq ON rbac_policy_group_policies (policy_group_id, policy_id);

CREATE TABLE rbac_user_policy_groups (
  id text PRIMARY KEY NOT NULL,
  subject_id text NOT NULL,
  policy_group_id text NOT NULL REFERENCES rbac_policy_groups(id),
  portal text NOT NULL DEFAULT '',
  context_id text NOT NULL DEFAULT '',
  created_at integer NOT NULL
);
CREATE UNIQUE INDEX rbac_upg_tuple_uq ON rbac_user_policy_groups (subject_id, policy_group_id, portal, context_id);
CREATE INDEX rbac_upg_subject_idx ON rbac_user_policy_groups (subject_id);

CREATE TABLE rbac_user_policies (
  id text PRIMARY KEY NOT NULL,
  subject_id text NOT NULL,
  policy_id text NOT NULL REFERENCES rbac_policies(id),
  portal text NOT NULL DEFAULT '',
  context_id text NOT NULL DEFAULT '',
  scope text,
  created_at integer NOT NULL
);
CREATE UNIQUE INDEX rbac_up_tuple_uq ON rbac_user_policies (subject_id, policy_id, portal, context_id);
CREATE INDEX rbac_up_subject_idx ON rbac_user_policies (subject_id);

CREATE TABLE rbac_resource_owners (
  id text PRIMARY KEY NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  owner_id text NOT NULL,
  context_type text NOT NULL DEFAULT '',
  context_id text NOT NULL DEFAULT '',
  created_at integer NOT NULL
);
CREATE UNIQUE INDEX rbac_ro_tuple_uq ON rbac_resource_owners (resource_type, resource_id, owner_id);
CREATE INDEX rbac_ro_resource_idx ON rbac_resource_owners (resource_type, resource_id);
`

export interface SqliteTestDb {
  db: BunSQLiteDatabase
  sqlite: Database
}

/** Fresh, fully-migrated in-memory database per call — no shared state. */
export function makeSqliteDb(): SqliteTestDb {
  const sqlite = new Database(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  sqlite.exec(DDL)
  const db = drizzle(sqlite)
  return { db, sqlite }
}
