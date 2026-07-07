import { defineConfig } from '@kyrobit/kyroguard'

export default defineConfig({
  // Lazy adapter factory: only db-touching commands (`kyroguard sync`, `kyroguard status`)
  // open a connection — `kyroguard generate` never does, and the CLI itself never
  // imports a database driver.
  adapter: async () => {
    const { PrismaClient } = await import('@prisma/client')
    const { prismaAdapter } = await import('@kyrobit/kyroguard/prisma')
    // Prisma migrations own DDL: include the rbac models (prisma/rbac.prisma)
    // in your schema and run `prisma migrate dev` before `kyroguard sync`.
    return prismaAdapter(new PrismaClient())
  },
  domains: [
    {
      name: '{{DOMAIN}}',
      policies: './src/rbac/policies.ts',
      groups: './src/rbac/groups.ts',
    },
  ],
  typegen: { output: './kyroguard.d.ts' },
})
