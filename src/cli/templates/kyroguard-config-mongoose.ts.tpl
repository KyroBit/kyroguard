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
  // Scanned by convention: policies/<domain>.ts is a domain, groups/<domain>.ts
  // attaches to it. Adding a domain is adding a file.
  domains: './src/kyroguard',
  typegen: { output: './kyroguard.d.ts' },
})
