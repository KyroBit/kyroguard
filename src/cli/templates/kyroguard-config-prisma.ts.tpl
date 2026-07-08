import { defineConfig } from '@kyrobit/kyroguard'

export default defineConfig({
  // Lazy adapter factory: only db-touching commands (`kyroguard sync`, `kyroguard status`)
  // open a connection — `kyroguard generate` never does, and the CLI itself never
  // imports a database driver.
  adapter: async () => {
    const { PrismaClient } = await import('@prisma/client')
    const { prismaAdapter } = await import('@kyrobit/kyroguard/prisma')
    // Prisma migrations own DDL: include the kyroguard models (prisma/kyroguard.prisma)
    // in your schema and run `prisma migrate dev` before `kyroguard sync`.
    return prismaAdapter(new PrismaClient())
  },
  // Scanned by convention: policies/<domain>.ts is a domain, groups/<domain>.ts
  // attaches to it. Adding a domain is adding a file.
  domains: './src/kyroguard',
  typegen: { output: './kyroguard.d.ts' },
})
