import { defineConfig } from '@kyrobit/rbac'

export default defineConfig({
  // Lazy adapter factory: only db-touching commands (`rbac sync`, `rbac status`)
  // open a connection — `rbac generate` never does, and the CLI itself never
  // imports a database driver.
  adapter: async () => {
    const { PrismaClient } = await import('@prisma/client')
    const { prismaAdapter } = await import('@kyrobit/rbac/prisma')
    // Prisma migrations own DDL: include the rbac models (prisma/rbac.prisma)
    // in your schema and run `prisma migrate dev` before `rbac sync`.
    return prismaAdapter(new PrismaClient())
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
