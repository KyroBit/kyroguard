import { defineConfig } from '@kyrobit/kyroguard'

export default defineConfig({
  // Lazy adapter factory: only db-touching commands (`kyroguard sync`, `kyroguard status`)
  // open a connection — `kyroguard generate` never does, and the CLI itself never
  // imports a database driver.
  adapter: async () => {
    const { drizzleAdapter } = await import('@kyrobit/kyroguard/drizzle')
    // The kyroguard tables ({{DIALECT}}) — add this file to your drizzle-kit schema
    // paths and run your migrations before `kyroguard sync`.
    const schema = await import('./src/db/kyroguard-schema.js')
    // TODO: import your drizzle instance.
    const { db } = await import('./src/db/index.js')
    return drizzleAdapter(db, { schema })
  },
  // Scanned by convention: policies/<domain>.ts is a domain, groups/<domain>.ts
  // attaches to it. Adding a domain is adding a file.
  domains: './src/kyroguard',
  typegen: { output: './kyroguard.d.ts' },
})
