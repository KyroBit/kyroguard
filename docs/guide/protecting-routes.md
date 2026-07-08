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

`teachers` is the unnamed domain from the [Fastify](/guide/fastify) or [Express](/guide/express) setup; named domains and their policy prefixes are covered in [Domains](/guide/domains).

## getSubject

Return the logged-in user, or `null`:

```ts
const teachers = app.kyroguard.domain({
  getSubject: async req => {
    const token = req.headers.authorization?.slice('Bearer '.length)
    if (!token) return null
    const payload = await verifyJwt(token)
    return payload ? { id: payload.sub, tenant_id: payload.schoolId } : null
  },
})
```

`getSubject` runs once per request, when the first guard fires. Return `null` and the guard responds 401. The `id` is any string that identifies the user. `tenant_id` is optional and marks the school. See [Domains](/guide/domains).

## The four outcomes

Every guarded request ends one of four ways:

| Status | Meaning | `code` in the body |
| --- | --- | --- |
| 200 | Allowed | — |
| 401 | No logged-in user | `UNAUTHENTICATED` |
| 403 | Policy not granted, or scope check failed | `ACCESS_DENIED` (`reason: 'policy'` / `'scope'`) |
| 404 | Scoped grant, but the resource does not exist | `NOT_FOUND` |

The exact response bodies are shown in [Fastify](/guide/fastify) and [Express](/guide/express).

## Scoped grants check the target row

A grant can carry a scope: a teacher holds `grades.update` scoped to `owned`; the coordinator holds it scoped to `in-tenant` ([Scopes](/guide/scopes)). A scoped grant checks the row the request targets. On a route with an `:id` param, the guard finds that row by itself:

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

The guard pairs the policy's resource type — `grade` — with `req.params.id`. Nothing to configure. A teacher updates only the grades they entered. The coordinator updates any grade in the school. An `'all'` grant skips the row check entirely.

A route whose param is not `:id` needs a custom resolver:

```ts
teachers.requirePolicy('grades.update', {
  resource: req => ({ type: 'grade', id: (req.params as { gradeId: string }).gradeId }),
})
```

Return `null` when the grade does not exist — the guard responds 404. Details in the [Fastify](/reference/fastify#domain-instance) and [Express](/reference/express#domain-instance) references.

On a route with no `:id` and no resolver, row scopes fail closed. The scoped grant is denied; condition scopes like `'grading-window'` still work ([Scopes](/guide/scopes)).
