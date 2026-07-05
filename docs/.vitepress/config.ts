import { defineConfig } from 'vitepress'

export default defineConfig({
  title: '@kyrobit/rbac',
  description:
    'Policy-based access control with portals, tenant contexts, scopes and resource ownership. Framework-agnostic core with Fastify, Express, Drizzle (PostgreSQL/MySQL/SQLite), Prisma and Mongoose integrations.',

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'Reference', link: '/reference/core-api' },
      { text: 'GitHub', link: 'https://github.com/KyroBit/rbac' },
    ],

    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Introduction', link: '/guide/introduction' },
          { text: 'Installation', link: '/guide/installation' },
          { text: 'Quick start', link: '/guide/quick-start' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Defining policies', link: '/guide/defining-policies' },
          { text: 'Organizing groups', link: '/guide/organizing-groups' },
          { text: 'Syncing policies', link: '/guide/syncing-policies' },
          { text: 'Setting up Fastify', link: '/guide/setting-up-fastify' },
          { text: 'Setting up Express', link: '/guide/setting-up-express' },
          { text: 'Resolving the subject', link: '/guide/resolving-the-subject' },
          { text: 'Protecting routes', link: '/guide/protecting-routes' },
          { text: 'Assigning access', link: '/guide/assigning-access' },
          { text: 'Portals', link: '/guide/portals' },
          { text: 'Tenant contexts', link: '/guide/tenant-contexts' },
          { text: 'Writing scopes', link: '/guide/writing-scopes' },
          { text: 'Tracking ownership', link: '/guide/tracking-ownership' },
          { text: 'Caching', link: '/guide/caching' },
          { text: 'Observability', link: '/guide/observability' },
          { text: 'Super users', link: '/guide/super-users' },
          { text: 'TypeScript', link: '/guide/typescript' },
          { text: 'Writing a storage adapter', link: '/guide/writing-a-storage-adapter' },
          { text: 'Testing your app', link: '/guide/testing-your-app' },
        ],
      },
      {
        text: 'Databases',
        items: [
          { text: 'Drizzle + PostgreSQL', link: '/databases/drizzle-postgres' },
          { text: 'Drizzle + MySQL', link: '/databases/drizzle-mysql' },
          { text: 'Drizzle + SQLite', link: '/databases/drizzle-sqlite' },
          { text: 'Prisma', link: '/databases/prisma' },
          { text: 'Mongoose', link: '/databases/mongoose' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Core API', link: '/reference/core-api' },
          { text: 'Fastify', link: '/reference/fastify' },
          { text: 'Express', link: '/reference/express' },
          { text: 'Drizzle', link: '/reference/drizzle' },
          { text: 'Prisma', link: '/reference/prisma' },
          { text: 'Mongoose', link: '/reference/mongoose' },
          { text: 'Cache', link: '/reference/cache' },
          { text: 'Testing', link: '/reference/testing' },
          { text: 'CLI', link: '/reference/cli' },
          { text: 'Configuration', link: '/reference/configuration' },
          { text: 'Database schema', link: '/reference/database-schema' },
          { text: 'Errors', link: '/reference/errors' },
          { text: 'Compatibility', link: '/reference/compatibility' },
        ],
      },
      {
        text: 'Migration',
        items: [{ text: 'Migrating from v0', link: '/guide/migrating-from-v0' }],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/KyroBit/rbac' }],

    outline: { level: [2, 3] },
  },
})
