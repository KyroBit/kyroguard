import { defineConfig } from '@kyrobit/kyroguard'

export default defineConfig({
  // Lazy adapter factory: only db-touching commands (`kyroguard sync`, `kyroguard status`)
  // open a connection — `kyroguard generate` never does, and the CLI itself never
  // imports a database driver.
  adapter: async () => {
    const { createConnection } = await import('mongoose')
    const { mongooseAdapter } = await import('@kyrobit/kyroguard/mongoose')
    const connection = await createConnection(
      process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/app',
    ).asPromise()
    return mongooseAdapter(connection)
  },
  domains: [
    {
      name: '{{DOMAIN}}',
      policies: './src/kyroguard/policies.ts',
      groups: './src/kyroguard/groups.ts',
    },
  ],
  typegen: { output: './kyroguard.d.ts' },
})
