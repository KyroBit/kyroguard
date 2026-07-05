/// <reference types="bun-types" />
/**
 * PGlite test database helper.
 *
 * Creates an in-memory PostgreSQL instance (@electric-sql/pglite) wrapped in
 * drizzle's pglite driver, with the six rbac tables created via hand-written
 * DDL that mirrors src/storage/drizzle/schema/pg.ts exactly:
 *  - text ids (application-generated via $defaultFn/createId — no DB default),
 *  - NOT NULL DEFAULT '' sentinels on portal/context columns (S1),
 *  - real booleans on rbac_policy_groups,
 *  - jsonb scope_options/depends_on with '[]' defaults,
 *  - the unique constraints/indexes the idempotent upserts rely on (S10, S13),
 *  - FKs matching .references() in the schema.
 */

import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

export type PgTestDatabase = ReturnType<typeof drizzle>

export interface PgTestDb {
  client: PGlite
  db: PgTestDatabase
  close: () => Promise<void>
}

export const RBAC_PG_DDL = `
CREATE TABLE "rbac_policies" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL UNIQUE,
  "portal" text NOT NULL DEFAULT '',
  "label" text NOT NULL,
  "scope_options" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "depends_on" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE "rbac_policy_groups" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL UNIQUE,
  "label" text NOT NULL,
  "description" text,
  "is_system" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE "rbac_policy_group_policies" (
  "id" text PRIMARY KEY,
  "policy_group_id" text NOT NULL REFERENCES "rbac_policy_groups"("id"),
  "policy_id" text NOT NULL REFERENCES "rbac_policies"("id"),
  "scope" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "rbac_pgp_group_policy_uq"
  ON "rbac_policy_group_policies" ("policy_group_id", "policy_id");

CREATE TABLE "rbac_user_policy_groups" (
  "id" text PRIMARY KEY,
  "subject_id" text NOT NULL,
  "policy_group_id" text NOT NULL REFERENCES "rbac_policy_groups"("id"),
  "portal" text NOT NULL DEFAULT '',
  "context_id" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "rbac_upg_tuple_uq"
  ON "rbac_user_policy_groups" ("subject_id", "policy_group_id", "portal", "context_id");
CREATE INDEX "rbac_upg_subject_idx" ON "rbac_user_policy_groups" ("subject_id");

CREATE TABLE "rbac_user_policies" (
  "id" text PRIMARY KEY,
  "subject_id" text NOT NULL,
  "policy_id" text NOT NULL REFERENCES "rbac_policies"("id"),
  "portal" text NOT NULL DEFAULT '',
  "context_id" text NOT NULL DEFAULT '',
  "scope" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "rbac_up_tuple_uq"
  ON "rbac_user_policies" ("subject_id", "policy_id", "portal", "context_id");
CREATE INDEX "rbac_up_subject_idx" ON "rbac_user_policies" ("subject_id");

CREATE TABLE "rbac_resource_owners" (
  "id" text PRIMARY KEY,
  "resource_type" text NOT NULL,
  "resource_id" text NOT NULL,
  "owner_id" text NOT NULL,
  "context_type" text NOT NULL DEFAULT '',
  "context_id" text NOT NULL DEFAULT '',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "rbac_ro_tuple_uq"
  ON "rbac_resource_owners" ("resource_type", "resource_id", "owner_id");
CREATE INDEX "rbac_ro_resource_idx"
  ON "rbac_resource_owners" ("resource_type", "resource_id");
`

/**
 * Fresh in-memory PostgreSQL with the rbac tables created. `extraDdl` lets a
 * test add its own user tables (posts, ...) in the same round-trip.
 */
export async function makePgDb(extraDdl?: string): Promise<PgTestDb> {
  const client = new PGlite()
  await client.exec(RBAC_PG_DDL)
  if (extraDdl) await client.exec(extraDdl)
  const db = drizzle(client)
  return { client, db, close: () => client.close() }
}
