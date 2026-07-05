# Database schema

`@kyrobit/rbac` stores everything in six tables (SQL) or six collections (MongoDB). This page documents every column, constraint and index, and the invariant each one enforces. Clause numbers (S1, S10, ...) refer to the storage adapter contract in `src/storage/contract.ts`, which the contract test suite in `@kyrobit/rbac/testing` executes.

For Drizzle, the tables come from the schema subpaths — `@kyrobit/rbac/drizzle/schema/pg`, `/mysql` or `/sqlite` — each exporting `rbacPolicies`, `rbacPolicyGroups`, `rbacPolicyGroupPolicies`, `rbacUserPolicyGroups`, `rbacUserPolicies`, `rbacResourceOwners`, a `tables` barrel and a `dialect` constant; `rbac init` copies the right one into `src/db/rbac-schema.ts` for your migrations. For Prisma, `rbac init` writes the same six tables as Prisma models to `prisma/rbac.prisma` (the `prismaSchemaSnippet` export), whose `@@map`/`@map` attributes pin the exact table, column and constraint names of the Drizzle schemas. For Mongoose, `mongooseAdapter(connection)` creates the models and `rbac sync` builds the indexes via `ensureSchema()` (`syncIndexes()`).

## How the tables relate

```
rbac_policies ──< rbac_policy_group_policies >── rbac_policy_groups
      │                                                 │
      └──< rbac_user_policies          rbac_user_policy_groups >──┘
                (subject_id)                  (subject_id)

rbac_resource_owners   (no foreign keys — points at your app's rows)
```

- **`rbac_policies` ↔ `rbac_policy_groups`** is a many-to-many through `rbac_policy_group_policies`; the per-pair `scope` column records how a group grants a policy.
- **`rbac_user_policies`** and **`rbac_user_policy_groups`** attach policies and groups to subjects. `subject_id` has no foreign key on purpose: subjects live in your application's own tables and the library never assumes their shape.
- **`rbac_resource_owners`** is standalone: `(resource_type, resource_id)` identifies one of your application's rows and `owner_id` a subject — both outside this schema, so no foreign keys are possible.

The SQL foreign keys on `policy_id` / `policy_group_id` are plain references. Deleting a policy cascades to group entries and direct assignments in adapter code (S6, transactional on SQL backends), not through `ON DELETE CASCADE`.

## The `''` sentinel (S1)

`portal`, `context_id` and `context_type` are `NOT NULL DEFAULT ''` everywhere. The empty string — not `NULL` — means "none", for two load-bearing reasons:

1. **Unique constraints must see one value for "none".** SQL unique indexes treat `NULL`s as distinct on all three supported dialects, so a tuple constraint containing a nullable column cannot enforce assignment idempotency — the same assignment could be inserted twice. With `''`, `(subject, group, '', '')` collides with itself and the upsert semantics of S10 hold on every backend.
2. **Matching must be plain equality.** `context_id = NULL` is never true in SQL; supporting `NULL` would force `IS NULL` special cases in every adapter, and each special case is a chance for a fallback bug. With `''`, grant lookup is strict equality on `(subject_id, portal, context_id)` (S2): a grant with no context never applies to a request with one, and vice versa — this is what keeps tenant data isolated.

Application code never writes `''` by hand — `toSubjectRef` and the portal layer normalize missing `portal`/`context_id` to the sentinel.

## `rbac_policies`

One row per fully-qualified policy name, written by `rbac sync` (S5). `name` includes the portal prefix (`admin.posts.read`); `portal` stores the portal it was synced under, which is what orphan cleanup filters on (S19).

::: code-group

```text [pg]
column         type       null  default
─────────────────────────────────────────────────────────────
id             text       no    cuid2, set by Drizzle at insert   PRIMARY KEY
name           text       no    —                                 UNIQUE
portal         text       no    ''
label          text       no    —
scope_options  jsonb      no    '[]'
depends_on     jsonb      no    '[]'
created_at     timestamp  no    now()
updated_at     timestamp  no    now()
```

```text [mysql]
column         type          null  default
─────────────────────────────────────────────────────────────
id             varchar(191)  no    cuid2, set by Drizzle at insert   PRIMARY KEY
name           varchar(191)  no    —                                 UNIQUE
portal         varchar(191)  no    ''
label          varchar(255)  no    —
scope_options  json          no    '[]'
depends_on     json          no    '[]'
created_at     timestamp     no    now()
updated_at     timestamp     no    now()
```

```text [sqlite]
column         type                    null  default
─────────────────────────────────────────────────────────────
id             text                    no    cuid2, set by Drizzle at insert   PRIMARY KEY
name           text                    no    —                                 UNIQUE
portal         text                    no    ''
label          text                    no    —
scope_options  text (JSON)             no    '[]'
depends_on     text (JSON)             no    '[]'
created_at     integer (unix seconds)  no    set by Drizzle at insert
updated_at     integer (unix seconds)  no    set by Drizzle at insert
```

```text [Mongoose]
model RbacPolicy → collection "rbacpolicies"

field         type      required  default
─────────────────────────────────────────────────────────────
_id           ObjectId  yes       generated
name          String    yes       —            UNIQUE index
portal        String    yes       ''
label         String    yes       ''
scopeOptions  [String]  yes       []
dependsOn     [String]  yes       []
createdAt     Date      —         timestamps: true
updatedAt     Date      —         timestamps: true
```

:::

**Constraints and what they enforce**

| Constraint | Invariant |
| --- | --- |
| `name` UNIQUE | The fully-qualified name is the policy's identity. Assignments look policies up by name (S12), and re-syncing updates the existing row instead of duplicating it (S5). |

## `rbac_policy_groups`

One row per group (role). Seeded by `rbac sync` from your `GroupsDefinition`, idempotent on `name` (S7).

::: code-group

```text [pg]
column       type       null  default
─────────────────────────────────────────────────────────────
id           text       no    cuid2, set by Drizzle at insert   PRIMARY KEY
name         text       no    —                                 UNIQUE
label        text       no    —
description  text       yes   NULL
is_system    boolean    no    false
is_active    boolean    no    true
created_at   timestamp  no    now()
updated_at   timestamp  no    now()
```

```text [mysql]
column       type          null  default
─────────────────────────────────────────────────────────────
id           varchar(191)  no    cuid2, set by Drizzle at insert   PRIMARY KEY
name         varchar(191)  no    —                                 UNIQUE
label        varchar(255)  no    —
description  text          yes   NULL
is_system    boolean       no    false
is_active    boolean       no    true
created_at   timestamp     no    now()
updated_at   timestamp     no    now()
```

```text [sqlite]
column       type                    null  default
─────────────────────────────────────────────────────────────
id           text                    no    cuid2, set by Drizzle at insert   PRIMARY KEY
name         text                    no    —                                 UNIQUE
label        text                    no    —
description  text                    yes   NULL
is_system    integer (boolean)       no    false (0)
is_active    integer (boolean)       no    true (1)
created_at   integer (unix seconds)  no    set by Drizzle at insert
updated_at   integer (unix seconds)  no    set by Drizzle at insert
```

```text [Mongoose]
model RbacPolicyGroup → collection "rbacpolicygroups"

field        type     required  default
─────────────────────────────────────────────────────────────
_id          ObjectId  yes      generated
name         String    yes      —            UNIQUE index
label        String    yes      ''
description  String    yes      ''           (SQL: nullable — Mongo stores '')
isSystem     Boolean   yes      false
isActive     Boolean   yes      true
createdAt    Date      —        timestamps: true
updatedAt    Date      —        timestamps: true
```

:::

**Constraints and what they enforce**

| Constraint | Invariant |
| --- | --- |
| `name` UNIQUE | `upsertGroup` is idempotent on name (S7): re-seeding updates metadata without duplicating the group or destroying its policy entries. |

`is_active = false` is the kill switch for a whole role: `getSubjectPolicies` excludes grants from inactive groups while leaving direct grants untouched (S20).

## `rbac_policy_group_policies`

The many-to-many join: which policies a group grants, and with what scope (`NULL` = unrestricted).

::: code-group

```text [pg]
column           type       null  default
─────────────────────────────────────────────────────────────
id               text       no    cuid2, set by Drizzle at insert   PRIMARY KEY
policy_group_id  text       no    —      FK → rbac_policy_groups.id
policy_id        text       no    —      FK → rbac_policies.id
scope            text       yes   NULL
created_at       timestamp  no    now()
```

```text [mysql]
column           type          null  default
─────────────────────────────────────────────────────────────
id               varchar(191)  no    cuid2, set by Drizzle at insert   PRIMARY KEY
policy_group_id  varchar(191)  no    —      FK → rbac_policy_groups.id
policy_id        varchar(191)  no    —      FK → rbac_policies.id
scope            varchar(191)  yes   NULL
created_at       timestamp     no    now()
```

```text [sqlite]
column           type                    null  default
─────────────────────────────────────────────────────────────
id               text                    no    cuid2, set by Drizzle at insert   PRIMARY KEY
policy_group_id  text                    no    —      FK → rbac_policy_groups.id
policy_id        text                    no    —      FK → rbac_policies.id
scope            text                    yes   NULL
created_at       integer (unix seconds)  no    set by Drizzle at insert
```

```text [Mongoose]
model RbacPolicyGroupPolicy → collection "rbacpolicygrouppolicies"

field          type      required  default
─────────────────────────────────────────────────────────────
_id            ObjectId  yes       generated
policyGroupId  ObjectId  yes       —
policyId       ObjectId  yes       —
scope          String    no        null
(no timestamps)
```

:::

**Constraints and what they enforce**

| Constraint / index | Invariant |
| --- | --- |
| `rbac_pgp_group_policy_uq` UNIQUE (`policy_group_id`, `policy_id`) | A group carries a policy at most once. `addGroupPolicies` is additive and idempotent (S9); the scope lives on the single pair, so there is never ambiguity about how a group grants a policy. |

## `rbac_user_policy_groups`

Group assignments: subject × group × portal × context.

::: code-group

```text [pg]
column           type       null  default
─────────────────────────────────────────────────────────────
id               text       no    cuid2, set by Drizzle at insert   PRIMARY KEY
subject_id       text       no    —
policy_group_id  text       no    —      FK → rbac_policy_groups.id
portal           text       no    ''
context_id       text       no    ''
created_at       timestamp  no    now()
```

```text [mysql]
column           type          null  default
─────────────────────────────────────────────────────────────
id               varchar(191)  no    cuid2, set by Drizzle at insert   PRIMARY KEY
subject_id       varchar(191)  no    —
policy_group_id  varchar(191)  no    —      FK → rbac_policy_groups.id
portal           varchar(191)  no    ''
context_id       varchar(191)  no    ''
created_at       timestamp     no    now()
```

```text [sqlite]
column           type                    null  default
─────────────────────────────────────────────────────────────
id               text                    no    cuid2, set by Drizzle at insert   PRIMARY KEY
subject_id       text                    no    —
policy_group_id  text                    no    —      FK → rbac_policy_groups.id
portal           text                    no    ''
context_id       text                    no    ''
created_at       integer (unix seconds)  no    set by Drizzle at insert
```

```text [Mongoose]
model RbacUserPolicyGroup → collection "rbacuserpolicygroups"

field          type      required  default
─────────────────────────────────────────────────────────────
_id            ObjectId  yes       generated
subjectId      String    yes       —
policyGroupId  ObjectId  yes       —
portal         String    yes       ''
contextId      String    yes       ''
(no timestamps)
```

:::

**Constraints and what they enforce**

| Constraint / index | Invariant |
| --- | --- |
| `rbac_upg_tuple_uq` UNIQUE (`subject_id`, `policy_group_id`, `portal`, `context_id`) | Assignment idempotency (S10): `assignGroup` is an upsert against this tuple, so calling it twice leaves one row. Removal targets exactly one tuple (S11). |
| `rbac_upg_subject_idx` (`subject_id`) | The enforcement hot path — `getSubjectPolicies` filters by subject on every cache miss. |

## `rbac_user_policies`

Direct policy grants: subject × policy × portal × context, with an optional scope.

::: code-group

```text [pg]
column      type       null  default
─────────────────────────────────────────────────────────────
id          text       no    cuid2, set by Drizzle at insert   PRIMARY KEY
subject_id  text       no    —
policy_id   text       no    —      FK → rbac_policies.id
portal      text       no    ''
context_id  text       no    ''
scope       text       yes   NULL
created_at  timestamp  no    now()
```

```text [mysql]
column      type          null  default
─────────────────────────────────────────────────────────────
id          varchar(191)  no    cuid2, set by Drizzle at insert   PRIMARY KEY
subject_id  varchar(191)  no    —
policy_id   varchar(191)  no    —      FK → rbac_policies.id
portal      varchar(191)  no    ''
context_id  varchar(191)  no    ''
scope       varchar(191)  yes   NULL
created_at  timestamp     no    now()
```

```text [sqlite]
column      type                    null  default
─────────────────────────────────────────────────────────────
id          text                    no    cuid2, set by Drizzle at insert   PRIMARY KEY
subject_id  text                    no    —
policy_id   text                    no    —      FK → rbac_policies.id
portal      text                    no    ''
context_id  text                    no    ''
scope       text                    yes   NULL
created_at  integer (unix seconds)  no    set by Drizzle at insert
```

```text [Mongoose]
model RbacUserPolicy → collection "rbacuserpolicies"

field      type      required  default
─────────────────────────────────────────────────────────────
_id        ObjectId  yes       generated
subjectId  String    yes       —
policyId   ObjectId  yes       —
portal     String    yes       ''
contextId  String    yes       ''
scope      String    no        null
(no timestamps)
```

:::

**Constraints and what they enforce**

| Constraint / index | Invariant |
| --- | --- |
| `rbac_up_tuple_uq` UNIQUE (`subject_id`, `policy_id`, `portal`, `context_id`) | Assignment idempotency (S10), and the structural form of S3: direct grants are portal/context-scoped exactly like group assignments — the tuple includes both columns, so "the same grant in another context" is a different row. |
| `rbac_up_subject_idx` (`subject_id`) | Enforcement hot path, as above. |

## `rbac_resource_owners`

The portable ownership store behind `Scope.owned()` and `rbac.ownership` — identical behavior on every backend.

::: code-group

```text [pg]
column         type       null  default
─────────────────────────────────────────────────────────────
id             text       no    cuid2, set by Drizzle at insert   PRIMARY KEY
resource_type  text       no    —
resource_id    text       no    —
owner_id       text       no    —
context_type   text       no    ''
context_id     text       no    ''
created_at     timestamp  no    now()
```

```text [mysql]
column         type          null  default
─────────────────────────────────────────────────────────────
id             varchar(191)  no    cuid2, set by Drizzle at insert   PRIMARY KEY
resource_type  varchar(191)  no    —
resource_id    varchar(191)  no    —
owner_id       varchar(191)  no    —
context_type   varchar(191)  no    ''
context_id     varchar(191)  no    ''
created_at     timestamp     no    now()
```

```text [sqlite]
column         type                    null  default
─────────────────────────────────────────────────────────────
id             text                    no    cuid2, set by Drizzle at insert   PRIMARY KEY
resource_type  text                    no    —
resource_id    text                    no    —
owner_id       text                    no    —
context_type   text                    no    ''
context_id     text                    no    ''
created_at     integer (unix seconds)  no    set by Drizzle at insert
```

```text [Mongoose]
model RbacResourceOwner → collection "rbacresourceowners"

field         type      required  default
─────────────────────────────────────────────────────────────
_id           ObjectId  yes       generated
resourceType  String    yes       —
resourceId    String    yes       —
ownerId       String    yes       —
contextType   String    yes       ''
contextId     String    yes       ''
(no timestamps)
```

:::

**Constraints and what they enforce**

| Constraint / index | Invariant |
| --- | --- |
| `rbac_ro_tuple_uq` UNIQUE (`resource_type`, `resource_id`, `owner_id`) | Ownership recording is an upsert (S13): recording the same owner twice — for example a retried request with auto-tracking — leaves one row. |
| `rbac_ro_resource_idx` (`resource_type`, `resource_id`) | `isOwner` and `removeOwnership` look up by resource; this index serves the `Scope.owned()` check on every scoped request. |

`context_type` usually holds the portal the resource was created from and `context_id` the tenant context — both `''` sentinels; they are informational for the ownership row and do not participate in the `isOwner` match, which is exact on `(ownerId, type, id)` (S13).

::: warning MySQL: why `varchar(191)`
On MySQL, id-like and tuple columns are `varchar(191)`: it is the longest utf8mb4 length that keeps the four-column unique keys (191 × 4 bytes × 4 columns = 3,056 bytes) under InnoDB's 3,072-byte index limit. Subject ids, context ids and policy names longer than 191 characters do not fit this schema on MySQL; PostgreSQL and SQLite use unbounded `text`.
:::

## Ids and timestamps

- **Primary keys are cuid2 strings** generated client-side by Drizzle's `$defaultFn` (via `createId`, re-exported from `@kyrobit/rbac`), not by the database. Mongoose uses standard `ObjectId`s.
- **SQLite timestamps have no database default** — Drizzle fills them at insert time (unix seconds, `integer` mode `timestamp`). Rows inserted outside Drizzle must set them explicitly. PostgreSQL and MySQL default to `now()` at the database level.
- **Mongoose keeps `createdAt`/`updatedAt` only on policies and groups** (`timestamps: true`); the assignment and ownership collections carry no timestamps, unlike their SQL counterparts which have `created_at`.

## Next steps

- [Drizzle + PostgreSQL](/databases/drizzle-postgres) — wiring the schema into your migrations.
- [Mongoose](/databases/mongoose) — models, indexes and `ensureSchema`.
- [Migrating from v0](/guide/migrating-from-v0) — the SQL that moves a v0 database onto this schema.
