/**
 * The Prisma models the CLI scaffolds from. `@@map`/`@map` pin the exact
 * table/column names of the canonical Drizzle schema (schema/pg.ts) so a
 * Prisma client and a Drizzle client can operate on the SAME database, and
 * the compound `@@unique` names double as the compound-unique inputs the
 * adapter relies on — change either only in lockstep with the adapter.
 */
export const prismaSchemaSnippet = `// ── @kyrobit/kyroguard models ─────────────────────────────────────────────────────
// Generated tables interoperate with the Drizzle schema: identical table
// names, snake_case columns, defaults and unique constraints.
// domain / tenantId use the '' sentinel (never NULL).

model KyroguardPolicy {
  id           String   @id @default(cuid())
  name         String   @unique(map: "kyroguard_policies_name_unique")
  domain       String   @default("")
  label        String
  scopeOptions Json     @default("[]") @map("scope_options")
  dependsOn    Json     @default("[]") @map("depends_on")
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @default(now()) @map("updated_at")

  groupEntries    KyroguardPolicyGroupPolicy[]
  userAssignments KyroguardUserPolicy[]

  @@map("kyroguard_policies")
}

model KyroguardPolicyGroup {
  id          String   @id @default(cuid())
  name        String   @unique(map: "kyroguard_policy_groups_name_unique")
  label       String
  description String?
  isSystem    Boolean  @default(false) @map("is_system")
  isActive    Boolean  @default(true) @map("is_active")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @default(now()) @map("updated_at")

  entries         KyroguardPolicyGroupPolicy[]
  userAssignments KyroguardUserPolicyGroup[]

  @@map("kyroguard_policy_groups")
}

model KyroguardPolicyGroupPolicy {
  id            String   @id @default(cuid())
  policyGroupId String   @map("policy_group_id")
  policyId      String   @map("policy_id")
  scope         String?
  createdAt     DateTime @default(now()) @map("created_at")

  policyGroup KyroguardPolicyGroup @relation(fields: [policyGroupId], references: [id])
  policy      KyroguardPolicy      @relation(fields: [policyId], references: [id])

  @@unique([policyGroupId, policyId], map: "kyroguard_pgp_group_policy_uq")
  @@map("kyroguard_policy_group_policies")
}

model KyroguardUserPolicyGroup {
  id            String   @id @default(cuid())
  subjectId     String   @map("subject_id")
  policyGroupId String   @map("policy_group_id")
  domain        String   @default("")
  tenantId      String   @default("") @map("tenant_id")
  createdAt     DateTime @default(now()) @map("created_at")

  policyGroup KyroguardPolicyGroup @relation(fields: [policyGroupId], references: [id])

  @@unique([subjectId, policyGroupId, domain, tenantId], map: "kyroguard_upg_tuple_uq")
  @@index([subjectId], map: "kyroguard_upg_subject_idx")
  @@map("kyroguard_user_policy_groups")
}

model KyroguardUserPolicy {
  id        String   @id @default(cuid())
  subjectId String   @map("subject_id")
  policyId  String   @map("policy_id")
  domain    String   @default("")
  tenantId  String   @default("") @map("tenant_id")
  scope     String?
  createdAt DateTime @default(now()) @map("created_at")

  policy KyroguardPolicy @relation(fields: [policyId], references: [id])

  @@unique([subjectId, policyId, domain, tenantId], map: "kyroguard_up_tuple_uq")
  @@index([subjectId], map: "kyroguard_up_subject_idx")
  @@map("kyroguard_user_policies")
}

model KyroguardResourceOwner {
  id           String   @id @default(cuid())
  resourceType String   @map("resource_type")
  resourceId   String   @map("resource_id")
  ownerId      String   @map("owner_id")
  relation     String   @default("owner")
  domain       String   @default("")
  tenantId     String   @default("") @map("tenant_id")
  createdAt    DateTime @default(now()) @map("created_at")

  @@unique([resourceType, resourceId, ownerId, relation], map: "kyroguard_ro_tuple_uq")
  @@index([resourceType, resourceId], map: "kyroguard_ro_resource_idx")
  @@index([resourceType, ownerId], map: "kyroguard_ro_owner_idx")
  @@map("kyroguard_resource_owners")
}
`
