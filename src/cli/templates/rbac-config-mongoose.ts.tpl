import { defineConfig } from '@kyrobit/rbac'

export default defineConfig({
  // Lazy adapter factory: only db-touching commands (`rbac sync`, `rbac status`)
  // open a connection — `rbac generate` never does, and the CLI itself never
  // imports a database driver.
  adapter: async () => {
    const { createConnection } = await import('mongoose')
    const { mongooseAdapter } = await import('@kyrobit/rbac/mongoose')
    const connection = await createConnection(
      process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/app',
    ).asPromise()
    return mongooseAdapter(connection)
  },
  portals: [
    {
      name: '{{PORTAL}}',
      policies: './src/rbac/policies.ts',
      groups: './src/rbac/groups.ts',
    },
  ],
  typegen: { output: './rbac.d.ts' },
})
