import { defineConfig } from 'vitepress'

export default defineConfig({
  title: '@kyrobit/rbac',
  description:
    'Permissions for your Node app. Define them in code, assign them to users, enforce them on routes.',

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
          { text: 'Quick start', link: '/guide/quick-start' },
          { text: 'Installation', link: '/guide/installation' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Policies', link: '/guide/policies' },
          { text: 'Groups', link: '/guide/groups' },
          { text: 'Sync', link: '/guide/sync' },
          { text: 'Fastify', link: '/guide/fastify' },
          { text: 'Express', link: '/guide/express' },
          { text: 'Protecting routes', link: '/guide/protecting-routes' },
          { text: 'Portals', link: '/guide/portals' },
          { text: 'Assigning access', link: '/guide/assigning-access' },
          { text: 'Scopes', link: '/guide/scopes' },
          { text: 'Ownership', link: '/guide/ownership' },
          { text: 'Production', link: '/guide/production' },
          { text: 'TypeScript', link: '/guide/typescript' },
          { text: 'Testing', link: '/guide/testing' },
          { text: 'Custom adapters', link: '/guide/custom-adapters' },
        ],
      },
      {
        text: 'Databases',
        items: [
          { text: 'Drizzle', link: '/databases/drizzle' },
          { text: 'Prisma', link: '/databases/prisma' },
          { text: 'MongoDB', link: '/databases/mongodb' },
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
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/KyroBit/rbac' }],

    outline: { level: [2, 3] },
  },
})
