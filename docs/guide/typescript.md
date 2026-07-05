# TypeScript

`rbac sync` writes an `rbac.d.ts` file. It turns your policy names into types.

Without it, any string compiles:

```ts
admin.requirePolicy('reprts.view') // typo — compiles, fails at runtime
```

With it, the typo is a compile error and your editor autocompletes real names:

```ts
admin.requirePolicy('reprts.view')
// error: '"reprts.view"' is not assignable to '"reports.view" | "staff.manage"'
```

## Generating the file

Both CLI commands write it:

```bash
npx rbac sync       # pushes policies to storage, then writes rbac.d.ts
npx rbac generate   # writes rbac.d.ts only — no database needed
```

The output path defaults to `./rbac.d.ts`. Change it in `rbac.config.ts` — see [Configuration](/reference/configuration).

Commit the file. It changes only when your policies change, and everyone gets the same types.

## Include it in tsconfig

The file must be part of your TypeScript program:

```json
{
  "include": ["src", "rbac.d.ts"]
}
```

If `include` already covers the directory the file is written to, you are done.

## What gets typed

- Domain names in `domain(name, ...)` (Fastify: `app.rbac.domain`).
- Policy names in `requirePolicy()`, per domain. The `admin` domain only accepts `admin` policies.
- Policy names in the domain's `assignPolicy()` / `removePolicy()`.

Before the file exists, all of these accept plain strings. Nothing breaks. You just get no checking.
