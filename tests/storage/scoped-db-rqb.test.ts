/// <reference types="bun-types" />
/**
 * scopedDb against Drizzle's relational query API (db.query.*).
 *
 * A registered table carries its filter however it is reached, so db.query must
 * behave like db.select(). Drizzle only exposes `where` on `many` relations, so a
 * `one` relation pointing at a registered table cannot be filtered — those fail
 * loudly rather than returning rows the grant does not allow.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { eq, relations } from 'drizzle-orm'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

import { createGuard, MisconfiguredError, Policy, Scope, toSubjectRef } from '../../src/index.js'
import type { GuardEngine, ResourceDefinition, Subject } from '../../src/index.js'
import { drizzleAdapter, scopedDb } from '../../src/storage/drizzle/index.js'
import * as pgSchema from '../../src/storage/drizzle/schema/pg.js'
import { KYROGUARD_PG_DDL } from './helpers/pg.js'

const authors = pgTable('authors', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
})

const articles = pgTable('articles', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  author_id: text('author_id').notNull(),
})

const comments = pgTable('comments', {
  id: text('id').primaryKey(),
  body: text('body').notNull(),
  article_id: text('article_id').notNull(),
})

const authorsRelations = relations(authors, ({ many }) => ({
  articles: many(articles),
}))

/** A one-relation pointing AT the filtered table — the case Drizzle cannot narrow. */
const commentsRelations = relations(comments, ({ one }) => ({
  article: one(articles, { fields: [comments.article_id], references: [articles.id] }),
}))

const articlesRelations = relations(articles, ({ one }) => ({
  author: one(authors, { fields: [articles.author_id], references: [authors.id] }),
}))

const schema = { authors, articles, comments, authorsRelations, articlesRelations, commentsRelations }

const USER_DDL = `
CREATE TABLE "authors" ("id" text PRIMARY KEY, "name" text NOT NULL);
CREATE TABLE "articles" (
  "id" text PRIMARY KEY,
  "title" text NOT NULL,
  "author_id" text NOT NULL
);
CREATE TABLE "comments" (
  "id" text PRIMARY KEY,
  "body" text NOT NULL,
  "article_id" text NOT NULL
);
`

const cleanups: Array<() => Promise<unknown>> = []
afterAll(async () => {
  for (const close of cleanups.reverse()) await close()
})

const writer: Subject = { id: 'writer' }

const runGuarded = <T>(
  engine: GuardEngine,
  subject: Subject,
  policy: string,
  resource: ResourceDefinition,
  fn: () => Promise<T>,
): Promise<T> =>
  engine.store.run(async () => {
    engine.store.setSubject(subject)
    await engine.authorize(subject, policy)
    await engine.storeFilterFor(subject, policy, resource)
    return await fn()
  })

/** `articles` is registered and scoped; `authors` is registered but never filtered. */
async function makeSetup(options?: { registerAuthors?: boolean }) {
  const client = new PGlite()
  await client.exec(KYROGUARD_PG_DDL)
  await client.exec(USER_DDL)
  cleanups.push(() => client.close())

  const raw = drizzle(client, { schema })
  const adapter = drizzleAdapter(raw, { schema: pgSchema })

  const ownScope = new Scope('own-articles', 'Own articles', subject => ({
    where: eq(articles.author_id, subject.id),
  }))

  const articleResource: ResourceDefinition = {
    type: 'article',
    policies: [new Policy('articles.read', { scopeOptions: [ownScope] })],
    table: articles,
  }
  const authorResource: ResourceDefinition = {
    type: 'author',
    policies: [],
    table: authors,
  }
  const resources = options?.registerAuthors ? [articleResource, authorResource] : [articleResource]

  const rbac = createGuard({ adapter, resources, cache: false })
  cleanups.push(async () => rbac.dispose())
  await rbac.sync()
  await rbac.engine.assignPolicy(toSubjectRef({ id: 'writer' }), 'articles.read', 'own-articles')

  await raw.insert(authors).values([
    { id: 'writer', name: 'Writer' },
    { id: 'other', name: 'Other' },
  ])
  await raw.insert(articles).values([
    { id: 'a1', title: 'mine', author_id: 'writer' },
    { id: 'a2', title: 'also mine', author_id: 'writer' },
    { id: 'a9', title: 'someone else', author_id: 'other' },
  ])
  await raw.insert(comments).values([{ id: 'c1', body: 'nice', article_id: 'a9' }])

  const db = scopedDb(raw, {
    guard: { engine: rbac.engine },
    resources,
    unscoped: ['test-bypass'],
    schema,
  })
  return { raw, db, engine: rbac.engine, articleResource }
}

describe('scopedDb — db.query carries the same filter as db.select', () => {
  test('m: findMany on a registered table applies the active filter', async () => {
    const { db, engine, articleResource } = await makeSetup()

    const rows = await runGuarded(engine, writer, 'articles.read', articleResource, () =>
      db.query.articles.findMany(),
    )

    expect(rows.map((row: any) => row.id).sort()).toEqual(['a1', 'a2'])
  })

  test('m: a caller where() is ANDed with the filter, never replaced', async () => {
    const { db, engine, articleResource } = await makeSetup()

    const rows = await runGuarded(engine, writer, 'articles.read', articleResource, () =>
      db.query.articles.findMany({ where: eq(articles.title, 'someone else') }),
    )

    expect(rows).toHaveLength(0)
  })

  test('m: findFirst is filtered too', async () => {
    const { db, engine, articleResource } = await makeSetup()

    const row = await runGuarded(engine, writer, 'articles.read', articleResource, () =>
      db.query.articles.findFirst({ where: eq(articles.id, 'a9') }),
    )

    expect(row).toBeUndefined()
  })

  test('m: a many relation pointing at a filtered table is filtered', async () => {
    const { db, engine, articleResource } = await makeSetup({ registerAuthors: true })

    const rows = await runGuarded(engine, writer, 'articles.read', articleResource, () =>
      db.query.authors.findMany({ with: { articles: true } }),
    )

    // 'other' wrote a9, which the subject's scope excludes — nested rows narrow too.
    const byAuthor = Object.fromEntries(
      rows.map((row: any) => [row.id, row.articles.map((article: any) => article.id).sort()]),
    )
    expect(byAuthor).toEqual({ writer: ['a1', 'a2'], other: [] })
  })

  test('m: a one relation pointing at a filtered table throws rather than leaking', async () => {
    const { db, engine, articleResource } = await makeSetup({ registerAuthors: true })

    // `article` is a one-relation onto the filtered table: Drizzle exposes no `where`
    // for it, so the rows cannot be narrowed and the query must not run.
    const error = await runGuarded(engine, writer, 'articles.read', articleResource, async () => {
      try {
        await db.query.comments.findMany({ with: { article: true } })
        return null
      } catch (thrown) {
        return thrown
      }
    })

    expect(error).toBeInstanceOf(MisconfiguredError)
  })

  test('m: unregistered tables are never filtered', async () => {
    const { db, engine, articleResource } = await makeSetup()

    const rows = await runGuarded(engine, writer, 'articles.read', articleResource, () =>
      db.query.authors.findMany(),
    )

    expect(rows.map((row: any) => row.id).sort()).toEqual(['other', 'writer'])
  })

  test('m: db.unscoped.query is never filtered', async () => {
    const { db, engine, articleResource } = await makeSetup()

    const rows = await runGuarded(engine, writer, 'articles.read', articleResource, () =>
      db.unscoped('test-bypass').query.articles.findMany(),
    )

    expect(rows.map((row: any) => row.id).sort()).toEqual(['a1', 'a2', 'a9'])
  })

  test('m: with no guard-activated filter the query runs plainly', async () => {
    const { db, engine } = await makeSetup()

    const rows = await engine.store.run(async () => {
      engine.store.setSubject(writer)
      return db.query.articles.findMany()
    })

    expect(rows.map((row: any) => row.id).sort()).toEqual(['a1', 'a2', 'a9'])
  })

  test('m: a db with no relational config at all still exposes db.query', async () => {
    const { engine, articleResource } = await makeSetup()
    const client = new PGlite()
    cleanups.push(() => client.close())

    const bare = drizzle(client)
    const db = scopedDb(bare, { guard: { engine }, resources: [articleResource], schema })

    expect((db as any).query).toEqual({})
  })
})
