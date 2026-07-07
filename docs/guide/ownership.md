# Ownership

`Scope.owned()` needs to know who created what. Ownership records answer that:

```ts
await rbac.ownership.isOwner(user.id, { type: 'grade', id: '42' })
```

Each record says: this user created this row. When a teacher enters a grade, the grade is theirs.

## Automatic tracking

The ORM integrations write ownership records on insert, attributed to the logged-in user. Wiring lives in your database page:

- [Drizzle](/databases/drizzle#_5-track-ownership-optional) — wrap your db with `trackedDb`.
- [Prisma](/databases/prisma#track-ownership-with-rbacprismaextension) — extend your client with `rbacPrismaExtension`.
- [MongoDB](/databases/mongodb#track-ownership-with-rbacmongooseplugin) — add `rbacMongoosePlugin` to each schema.

The same integrations also filter reads on guarded routes — see [Automatic filtering](/guide/scopes#automatic-filtering).

::: warning What is not tracked
Tracking hooks into the ORM. Raw SQL, bulk operations and other writes that bypass the hooks record nothing — each database page lists its exact gaps. On those paths, call `rbac.ownership.record()` yourself.
:::

## The manual API

```ts
// After creating a row outside the tracked path:
await rbac.ownership.record(user.id, { type: 'grade', id: grade.id })

// Ask the store directly:
const mine = await rbac.ownership.isOwner(user.id, { type: 'grade', id: grade.id })

// After deleting a row:
await rbac.ownership.remove({ type: 'grade', id: grade.id })
```

Recording twice is safe. `remove` clears everyone from the row — owners and grants alike.

## Owner entries and granted entries

Every record carries a relation. `rbac.ownership.record()` writes relation `'owner'`: the row's creator, what `Scope.owned()` checks. `rbac.access.grant()` writes relation `'granted'`: a row someone chose to share, what `Scope.granted()` checks. Same store, different meaning — a granted entry never passes an owned check.

## The access API

Ownership covers rows a user created. For rows someone *picks* — a substitute teacher covers two classes this week and needs exactly those classes' grades — grant access directly:

```ts
// For each grade in the two covered classes:
await rbac.access.grant(substitute.id, { type: 'grade', id: grade.id })

// The week is over — take it back:
await rbac.access.revoke(substitute.id, { type: 'grade', id: grade.id })

// Everyone on the grade — owner and grants:
const entries = await rbac.access.list({ type: 'grade', id: grade.id })
```

`Scope.granted()` is the built-in scope that turns these grants into access:

```ts
new Policy('grades.view', { scopeOptions: [Scope.granted()] })

// groups.ts
substitute: { policies: { 'grades.view': 'granted' } },
```

The substitute now sees the two classes' grades — at the guard and in their lists — until you revoke.

`grant` takes options: `relation` for a custom relation name, `domain` and `tenantId` to place the entry. `revoke` without a relation removes that user's entries under every relation; pass one to remove just it. Granting twice is safe, like recording.

## Background jobs

Automatic tracking attributes rows to the logged-in user. Seeders and background jobs have none, so their inserts record nothing. That is usually right. When a job imports last term's grades for a teacher, call `rbac.ownership.record()` with that teacher's id.
