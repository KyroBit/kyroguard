---
layout: home

hero:
  name: "@kyrobit/rbac"
  text: Role-based access control for Fastify
  tagline: Define permissions in code, group them into roles, assign them to users, and enforce them on routes. One command keeps your database in sync.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/introduction
    - theme: alt
      text: See Examples
      link: /examples/blog-cms

features:
  - title: Permissions as code
    details: Policies like transaction.view or blog.publish live in your codebase. Dependencies resolve automatically — granting blog.publish also grants blog.read.
  - title: One command to sync
    details: Define policies and groups in TypeScript. Run rbac sync before every deploy to push changes to the database and generate types for autocompletion.
  - title: Scopes for fine-grained control
    details: Need "only their own records" or "only during business hours"? Scopes are plain functions you write — query your tables, check time, call anything.
  - title: Multi-portal, zero bleed
    details: Admin, branch, cashier — each portal has its own isolated policies and groups. Assignments in one portal never affect another.
---
