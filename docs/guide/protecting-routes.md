# Protecting routes

`requirePolicy` guards a route:

::: code-group

```ts [Fastify]
app.get(
  '/grades',
  { preHandler: teachers.requirePolicy('grades.view') },
  listGrades,
)

app.post(
  '/grades',
  { preHandler: teachers.requirePolicy('grades.enter') },
  enterGrade,
)
```

```ts [Express]
app.get('/grades', teachers.requirePolicy('grades.view'), listGrades)
app.post('/grades', teachers.requirePolicy('grades.enter'), enterGrade)
```

:::

The user must hold the named policy. Otherwise the request is denied. Viewing grades and entering them are separate policies.

`teachers` is the domain from the [Fastify](/guide/fastify) or [Express](/guide/express) setup; how a domain prefixes its policy names is covered in [Domains](/guide/domains).

## getSubject

Return the logged-in user, or `null`:

```ts
const teachers = app.kyroguard.domain('teachers', {
  resources,
  getSubject: async req => {
    const token = req.headers.authorization?.slice('Bearer '.length)
    if (!token) return null
    const payload = await verifyJwt(token)
    return payload ? { id: payload.sub, tenant_id: payload.schoolId } : null
  },
})
```

`getSubject` runs once per request, when the first guard fires. Return `null` and the guard responds 401. The `id` is any string that identifies the user. `tenant_id` is optional and marks the school. See [Domains](/guide/domains).

## The outcomes

Every guarded request ends one of three ways:

| Status | Meaning | `code` in the body |
| --- | --- | --- |
| 200 | Allowed | — |
| 401 | No logged-in user | `UNAUTHENTICATED` |
| 403 | Policy not granted here | `ACCESS_DENIED` |

A scope never produces its own status: it narrows the query, so a row it excludes is simply not found and your handler's existing 404 branch answers.

The exact response bodies are shown in [Fastify](/guide/fastify) and [Express](/guide/express).

## Scoped grants narrow the query

A grant can carry a scope: a teacher holds `grades.update` scoped to `entered`; the coordinator holds it scoped to `in-school` ([Scopes](/guide/scopes)). The guard treats both the same way — the subject holds the policy, so the request proceeds. What changes is the query.

::: code-group

```ts [Fastify]
app.patch('/grades/:id', {
  preHandler: teachers.requirePolicy('grades.update'),
}, updateGrade)

app.delete('/grades/:id', {
  preHandler: teachers.requirePolicy('grades.delete'),
}, deleteGrade)
```

```ts [Express]
app.patch('/grades/:id', teachers.requirePolicy('grades.update'), updateGrade)
app.delete('/grades/:id', teachers.requirePolicy('grades.delete'), deleteGrade)
```

:::

Nothing to configure. Inside `updateGrade`, the teacher's `UPDATE … WHERE id = :id` also carries `entered_by = :them`; a grade someone else entered matches no rows, and the handler answers 404 exactly as it would for an id that does not exist. The coordinator's version carries `school_id = :theirSchool` instead. An `'all'` grant adds nothing.

Write the handler as if the row might simply not be there — that branch now does double duty, and it is the only one you need.

Which paths carry the condition depends on your ORM integration — [Drizzle](/reference/drizzle#what-gets-filtered), [Prisma](/reference/prisma#what-gets-filtered), [Mongoose](/reference/mongoose). Inserts never do: an owner or tenant column is yours to fill.

## Asking without enforcing

A guard answers with a status code, which is the wrong shape for a screen: you cannot render a toolbar by catching a 403. `can` asks the same question and answers `true` or `false`:

```ts
app.get('/grades/:id', { preHandler: teachers.requirePolicy('grades.view') }, async req => ({
  grade: await loadGrade(req.params.id),
  canDelete: await teachers.can(req, 'grades.delete'),
}))
```

An unauthenticated request answers `false` rather than 401, and a scoped grant answers `true` — the subject holds the policy; the scope decides rows, not permission.

For a whole screen, ask once instead of per button. `grantsFor` returns everything the subject holds in this domain, ready to send to a client:

```ts
app.get('/me/permissions', async req => teachers.grantsFor(req))
// { "grades.view": null, "grades.update": ["entered"] }
```

`null` is an unrestricted grant; an array names the [scopes](/guide/scopes) it carries. An owner (`is_super`) comes back holding every policy in the domain.

::: warning These render, they do not protect
Deciding what to show is not deciding what to allow. Keep `requirePolicy` on every route — a client can call the endpoint whatever the UI drew.
:::

Full contract in the [reference](/reference/core-api#can).
