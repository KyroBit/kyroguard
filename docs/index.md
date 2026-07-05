---
layout: home

hero:
  name: '@kyrobit/rbac'
  text: Policy-based access control for Node.js APIs
  tagline: Define policies in code, sync them to your database, and guard Fastify or Express routes with grants that are isolated per portal and per tenant.
  actions:
    - theme: brand
      text: Get started
      link: /guide/installation
    - theme: alt
      text: Quick start
      link: /guide/quick-start

features:
  - title: Policies synced from code
    details: Your policy definitions live in TypeScript files. `rbac sync` upserts them into storage, removes orphans for the synced portal, back-fills group dependencies and writes a typed rbac.d.ts for autocompletion.
  - title: Strict portal and tenant isolation
    details: Grants are matched on (subject, portal, context) by plain equality — a grant on the admin portal never satisfies a branch route, and a grant in tenant A never applies to tenant B. There is no fallback in either direction.
  - title: Your framework, your database
    details: Guards for Fastify 5 and Express 4/5. Storage adapters for Drizzle (PostgreSQL, MySQL, SQLite), Prisma and Mongoose, plus an in-memory adapter for tests — all validated against one executable contract suite.
  - title: Guard-time decisions with a bounded cache
    details: Every decision happens at guard time and either passes or throws a typed error with a stable RBAC_* code. Policy lookups go through a bounded in-memory LRU (10,000 entries, 30 s TTL by default) with cross-instance invalidation hooks.
---
