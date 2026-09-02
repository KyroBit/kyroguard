# Ownership

"Only the rows they created" is the most common scope there is. kyroguard has no opinion about how you record that — ownership is a column in **your** schema, and a [scope](/guide/scopes) is where you name it.

## The column

```ts
export const grades = pgTable('grades', {
  id: text('id').primaryKey(),
  enteredBy: text('entered_by').notNull(),
  schoolId: text('school_id').notNull(),
  // …
})
```

Fill it where you create the row — the same handler that already knows who is logged in:

```ts
await db.insert(grades).values({ ...input, enteredBy: req.authUser.id })
```

kyroguard does not write this for you and does not watch your inserts. That is deliberate: a hidden write is a hidden bug, and only your handler knows which column means "owner" for this table.

## The scope

```ts
export const entered = new Scope('entered', 'Entered by the teacher', subject => ({
  where: eq(grades.enteredBy, subject.id),
}))
```

Declare it on the policy and grant it to the role that should be limited:

```ts
new Policy('grades.update', { scopeOptions: [entered] })

// groups.ts
teacher: { policies: { 'grades.update': 'entered' } },
```

From then on every read, update and delete of `grades` under that grant carries `entered_by = :them`. A grade somebody else entered is invisible and unwritable — the query simply does not match it.

## Sharing chosen rows

Ownership covers rows a user created. For rows someone *picks* — a substitute teacher covers two classes this week and needs exactly those classes' grades — the same pattern applies, with a join table you own:

```ts
export const gradeShares = pgTable('grade_shares', {
  gradeId: text('grade_id').notNull(),
  userId: text('user_id').notNull(),
})
```

```ts
export const shared = new Scope('shared', 'Shared with the subject', (subject, ctx) => ({
  where: exists(
    (ctx.db as Db)
      .select({ one: sql`1` })
      .from(gradeShares)
      .where(and(eq(gradeShares.gradeId, grades.id), eq(gradeShares.userId, subject.id))),
  ),
}))
```

```ts
new Policy('grades.view', { scopeOptions: [entered, shared] })

// groups.ts
substitute: { policies: { 'grades.view': 'shared' } },
```

Insert a row into `grade_shares` to share, delete it to revoke. A subject holding both `entered` and `shared` on the same policy sees the union of both.

::: tip
Index the columns your scopes filter on. A scope becomes a `WHERE` on every query for that resource, so an unindexed owner column turns every list into a table scan.
:::

## Background jobs

A seeder or background job has no logged-in subject, so no guard runs and no scope is attached — its queries are unfiltered. Set the owner column explicitly in the job, exactly as a handler would.
