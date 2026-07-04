# Syncing

The `rbac sync` command is the bridge between your code and your database. It pushes your policy and group definitions to the database and regenerates `rbac.d.ts`. Run it on every deploy.

```bash
bunx --bun rbac sync
```

- Reads `rbac.config.ts` from the project root
- Loads `DATABASE_URL` from your `.env` automatically
- Creates its own database connection — you don't need to pass one
- Safe to run repeatedly (fully idempotent)

---

## What sync does

**Policies:**

| Situation | Action |
|---|---|
| New policy in code | Inserted into `rbac_policies` |
| Policy label or valid scopes changed | Updated in place |
| Policy renamed | Old row deleted (assignments removed), new row inserted |
| Policy removed from code | Deleted from the database along with all its assignments |
| `dependsOn` changed | Missing dependency policies are added to existing group assignments |

**Groups** (when `groups` is set in config):

| Situation | Action |
|---|---|
| New group in code | Inserted into `rbac_policy_groups` |
| Group label changed | Updated in place |
| Policy added to group | Assignment inserted |
| Policy removed from group | Assignment deleted |
| Policy scope changed in group | Assignments replaced |
| `policies: 'all'` | Assigns every policy from the paired portal |

---

## Deployment

```bash
# In your deploy script or Dockerfile
bunx --bun rbac sync
node dist/server.js
```

No separate seeder step is needed for policies or groups — sync handles it all.

---

**Next:** [Register the Fastify plugin](./plugin)
