import { defineConfig } from 'vitepress'

export default defineConfig({
  title:       '@kyrobit/rbac',
  description: 'Policy-based access control for Fastify + Drizzle',

  themeConfig: {
    nav: [
      { text: 'Guide',    link: '/guide/introduction' },
      { text: 'Examples', link: '/examples/blog-cms' },
      { text: 'GitHub',   link: 'https://github.com/KyroBit/rbac' },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction',   link: '/guide/introduction' },
          { text: 'Getting Started', link: '/guide/getting-started' },
        ],
      },
      {
        text: 'Core',
        items: [
          { text: 'Policies',                   link: '/guide/policies' },
          { text: 'Groups',                     link: '/guide/groups' },
          { text: 'Configuration & Sync',       link: '/guide/configuration' },
          { text: 'Plugin Setup',               link: '/guide/plugin' },
          { text: 'Identifying the Current User', link: '/guide/subject' },
          { text: 'Protecting Routes',          link: '/guide/protecting-routes' },
          { text: 'Assigning Users',            link: '/guide/assigning-users' },
        ],
      },
      {
        text: 'Multi-Tenant',
        items: [
          { text: 'Portals & Context',  link: '/guide/multi-tenant' },
          { text: 'is_super',           link: '/guide/is-super' },
        ],
      },
      {
        text: 'Advanced',
        items: [
          { text: 'Scopes',          link: '/guide/scopes' },
          { text: 'Custom Adapter',  link: '/guide/adapter' },
          { text: 'Policy Cache',    link: '/guide/cache' },
        ],
      },
      {
        text: 'Examples',
        items: [
          { text: 'Blog CMS',             link: '/examples/blog-cms' },
          { text: 'Multi-Portal App',     link: '/examples/multi-portal' },
          { text: 'Ownership Scope',      link: '/examples/own-scope' },
          { text: 'Multi-Tenant Branches', link: '/examples/multi-tenant' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/KyroBit/rbac' },
    ],
  },
})
