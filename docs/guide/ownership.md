# Ownership

`Scope.owned()` needs to know who created what. Ownership records answer that:

```ts
await rbac.ownership.isOwner(user.id, { type: 'sale', id: '42' })
```

Each record says: this user created this row. When a cashier records a sale, the sale is theirs.

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
await rbac.ownership.record(user.id, { type: 'sale', id: sale.id })

// Ask the store directly:
const mine = await rbac.ownership.isOwner(user.id, { type: 'sale', id: sale.id })

// After deleting a row:
await rbac.ownership.remove({ type: 'sale', id: sale.id })
```

Recording twice is safe. `remove` clears everyone from the row — owners and grants alike.

## Owner entries and granted entries

Every record carries a relation. `rbac.ownership.record()` writes relation `'owner'`: the row's creator, what `Scope.owned()` checks. `rbac.access.grant()` writes relation `'granted'`: a row someone chose to share, what `Scope.granted()` checks. Same store, different meaning — a granted entry never passes an owned check.

## The access API

Ownership covers rows a user created. For rows someone *picks* — share this report, assign this ticket — grant access directly:

```ts
// Share a report with Amina:
await rbac.access.grant(amina.id, { type: 'report', id: '7' })

// Take it back:
await rbac.access.revoke(amina.id, { type: 'report', id: '7' })

// Everyone on the report — owners and grants:
const entries = await rbac.access.list({ type: 'report', id: '7' })
```

`Scope.granted()` is the built-in scope that turns these grants into access:

```ts
new Policy('reports.view', { scopeOptions: [Scope.granted()] })

// groups.ts
analyst: { policies: { 'reports.view': 'granted' } },
```

Amina now sees report 7 — at the guard and in her lists — until you revoke.

`grant` takes options: `relation` for a custom relation name, `domain` and `tenantId` to place the entry. `revoke` without a relation removes that user's entries under every relation; pass one to remove just it. Granting twice is safe, like recording.

## Background jobs

Automatic tracking attributes rows to the logged-in user. Seeders and background jobs have none, so their inserts record nothing. That is usually right. When a job imports sales for a cashier, call `rbac.ownership.record()` with that cashier's id.
