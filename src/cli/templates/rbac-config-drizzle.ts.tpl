import { defineConfig } from '@kyrobit/rbac'

export default defineConfig({
  // Lazy adapter factory: only db-touching commands (`rbac sync`, `rbac status`)
  // open a connection — `rbac generate` never does, and the CLI itself never
  // imports a database driver.
  adapter: async () => {
    const { drizzleAdapter } = await import('@kyrobit/rbac/drizzle')
    // The rbac tables ({{DIALECT}}) — add this file to your drizzle-kit schema
    // paths and run your migrations before `rbac sync`.
    const schema = await import('./src/db/rbac-schema.js')
    // TODO: import your drizzle instance.
    const { db } = await import('./src/db/index.js')
    return drizzleAdapter(db, { schema })
  },
  domains: [
    {
      name: '{{DOMAIN}}',
      policies: './src/rbac/policies.ts',
      groups: './src/rbac/groups.ts',
    },
  ],
  typegen: { output: './rbac.d.ts' },
})
