/// <reference types="bun-types" />
/**
 * The school RBAC model end to end over HTTP. Each role's reach is a different
 * shape of rule — a join table for teachers, a guardian link for parents, the
 * subject's own id for students — so this is also the test that those three
 * shapes are all expressible.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { and, eq, exists, sql } from 'drizzle-orm'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

import { Policy, Scope, createGuard } from '../../src/index.js'
import type { Guard, ResourceDefinition, SubjectInput } from '../../src/index.js'
import type { FastifyDomain } from '../../src/frameworks/fastify/index.js'
import { createDomain, kyroguardFastify } from '../../src/frameworks/fastify/index.js'
import { drizzleAdapter, scopedDb } from '../../src/storage/drizzle/index.js'
import * as pgSchema from '../../src/storage/drizzle/schema/pg.js'
import { KYROGUARD_PG_DDL } from '../storage/helpers/pg.js'

const grades = pgTable('grades', {
  id: text('id').primaryKey(),
  studentId: text('student_id').notNull(),
  classId: text('class_id').notNull(),
  mark: text('mark').notNull(),
})

/** Which teacher teaches which class — the teacher's reach. */
const teaching = pgTable('teaching', {
  teacherId: text('teacher_id').notNull(),
  classId: text('class_id').notNull(),
})

/** Which parent guards which student — a parent may have several children. */
const guardians = pgTable('guardians', {
  parentId: text('parent_id').notNull(),
  studentId: text('student_id').notNull(),
})

const schema = { grades, teaching, guardians }

const USER_DDL = `
CREATE TABLE "grades" (
  "id" text PRIMARY KEY,
  "student_id" text NOT NULL,
  "class_id" text NOT NULL,
  "mark" text NOT NULL
);
CREATE TABLE "teaching" ("teacher_id" text NOT NULL, "class_id" text NOT NULL);
CREATE TABLE "guardians" ("parent_id" text NOT NULL, "student_id" text NOT NULL);
`

let rawDb: ReturnType<typeof drizzle<typeof schema>>

/** Grades of classes this teacher is assigned to. */
const assignedClasses = new Scope('assigned-classes', 'Classes they teach', subject => ({
  where: exists(
    rawDb
      .select({ one: sql`1` })
      .from(teaching)
      .where(and(eq(teaching.classId, grades.classId), eq(teaching.teacherId, subject.id))),
  ),
}))

/** Grades of students this parent guards — several children union naturally. */
const ownChildren = new Scope('own-children', 'Their children', subject => ({
  where: exists(
    rawDb
      .select({ one: sql`1` })
      .from(guardians)
      .where(and(eq(guardians.studentId, grades.studentId), eq(guardians.parentId, subject.id))),
  ),
}))

/** The student themselves. */
const ownRecord = new Scope('own-record', 'Their own record', subject => ({
  where: eq(grades.studentId, subject.id),
}))

const resources: ResourceDefinition[] = [
  {
    type: 'grade',
    table: grades,
    policies: [
      new Policy('grades.view', { scopeOptions: [assignedClasses, ownChildren, ownRecord] }),
      new Policy('grades.update', {
        dependsOn: ['grades.view'],
        scopeOptions: [assignedClasses],
      }),
    ],
  },
]

const DOMAINS = ['admin', 'teachers', 'students', 'parents'] as const

/** The office panel: the same permissions, declared with no scope at all. */
const adminResources: ResourceDefinition[] = [
  {
    type: 'grade',
    table: grades,
    policies: [new Policy('grades.view'), new Policy('grades.update', { dependsOn: ['grades.view'] })],
  },
]

let app: FastifyInstance
let guard: Guard
let domains: Record<(typeof DOMAINS)[number], FastifyDomain>
let close: () => Promise<void>

function subjectFrom(headers: Record<string, unknown>): SubjectInput | null {
  const id = headers['x-user']
  if (typeof id !== 'string' || id === '') return null
  const subject: SubjectInput = { id }
  if (headers['x-admin'] === '1') subject.is_super = true
  return subject
}

beforeAll(async () => {
  const client = new PGlite()
  await client.exec(KYROGUARD_PG_DDL)
  await client.exec(USER_DDL)

  rawDb = drizzle(client, { schema })
  guard = createGuard({ adapter: drizzleAdapter(rawDb, { schema: pgSchema }), cache: false })
  const db = scopedDb(rawDb, { guard: { engine: guard.engine }, resources, schema })

  for (const domain of DOMAINS) {
    await guard.sync(domain === 'admin' ? adminResources : resources, domain)
  }

  await rawDb.insert(teaching).values([{ teacherId: 'teacher-maths', classId: 'maths' }])
  await rawDb.insert(guardians).values([
    { parentId: 'parent-1', studentId: 'sara' },
    { parentId: 'parent-1', studentId: 'omar' },
  ])
  await rawDb.insert(grades).values([
    { id: 'g-sara-maths', studentId: 'sara', classId: 'maths', mark: '80' },
    { id: 'g-omar-maths', studentId: 'omar', classId: 'maths', mark: '70' },
    { id: 'g-sara-art', studentId: 'sara', classId: 'art', mark: '90' },
    { id: 'g-zain-maths', studentId: 'zain', classId: 'maths', mark: '60' },
    { id: 'g-zain-art', studentId: 'zain', classId: 'art', mark: '50' },
  ])

  app = Fastify()
  await app.register(kyroguardFastify(guard))

  domains = Object.fromEntries(
    DOMAINS.map(name => [
      name,
      createDomain(guard, name, {
        resources: name === 'admin' ? adminResources : resources,
        getSubject: req => subjectFrom(req.headers),
      }),
    ]),
  ) as typeof domains

  for (const [name, domain] of Object.entries(domains)) {
    app.get(
      `/${name}/grades`,
      { preHandler: domain.requirePolicy('grades.view') },
      async () => (await db.select().from(grades)).map(row => row.id).sort(),
    )
    app.post<{ Params: { id: string } }>(
      `/${name}/grades/:id`,
      { preHandler: domain.requirePolicy('grades.update') },
      async request => {
        const changed = await db
          .update(grades)
          .set({ mark: '100' })
          .where(eq(grades.id, request.params.id))
          .returning()
        return { changed: changed.map(row => row.id) }
      },
    )
  }

  await app.ready()
  close = async () => {
    await app.close()
    guard.dispose()
    await client.close()
  }

  await domains.teachers.assignPolicy('teacher-maths', 'grades.view', { scope: 'assigned-classes' })
  await domains.teachers.assignPolicy('teacher-maths', 'grades.update', { scope: 'assigned-classes' })
  await domains.parents.assignPolicy('parent-1', 'grades.view', { scope: 'own-children' })
  await domains.students.assignPolicy('sara', 'grades.view', { scope: 'own-record' })
})

afterAll(async () => {
  await close?.()
})

async function get(path: string, user: string, extra: Record<string, string> = {}) {
  const res = await app.inject({ method: 'GET', url: path, headers: { 'x-user': user, ...extra } })
  return { status: res.statusCode, body: res.body === '' ? null : JSON.parse(res.body) }
}

async function post(path: string, user: string) {
  const res = await app.inject({ method: 'POST', url: path, headers: { 'x-user': user } })
  return { status: res.statusCode, body: res.body === '' ? null : JSON.parse(res.body) }
}

describe('school: a teacher is scoped to the classes they teach', () => {
  test('sees every student’s grades in their own class, across students', async () => {
    const res = await get('/teachers/grades', 'teacher-maths')

    expect(res.status).toBe(200)
    expect(res.body).toEqual(['g-omar-maths', 'g-sara-maths', 'g-zain-maths'])
  })

  test('a class they do not teach is invisible', async () => {
    const res = await get('/teachers/grades', 'teacher-maths')

    expect(res.body).not.toContain('g-sara-art')
    expect(res.body).not.toContain('g-zain-art')
  })

  test('recording a mark in their own class writes the row', async () => {
    const res = await post('/teachers/grades/g-zain-maths', 'teacher-maths')

    expect(res.status).toBe(200)
    expect(res.body.changed).toEqual(['g-zain-maths'])
  })

  test('recording a mark outside their class writes nothing — the update matches no row', async () => {
    const res = await post('/teachers/grades/g-sara-art', 'teacher-maths')

    expect(res.status).toBe(200)
    expect(res.body.changed).toEqual([])

    const [row] = await rawDb.select().from(grades).where(eq(grades.id, 'g-sara-art'))
    expect(row?.mark).toBe('90')
  })
})

describe('school: a parent is scoped to their own children', () => {
  test('sees a consolidated view of both children, every class', async () => {
    const res = await get('/parents/grades', 'parent-1')

    expect(res.status).toBe(200)
    expect(res.body).toEqual(['g-omar-maths', 'g-sara-art', 'g-sara-maths'])
  })

  test('another family’s child never appears', async () => {
    const res = await get('/parents/grades', 'parent-1')

    expect(res.body).not.toContain('g-zain-maths')
  })

  test('a parent cannot record marks — they hold no update policy', async () => {
    const res = await post('/parents/grades/g-sara-maths', 'parent-1')

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ACCESS_DENIED')
  })
})

describe('school: a student is scoped to themselves', () => {
  test('sees only their own grades, across every class', async () => {
    const res = await get('/students/grades', 'sara')

    expect(res.status).toBe(200)
    expect(res.body).toEqual(['g-sara-art', 'g-sara-maths'])
  })

  test('a classmate’s grades never appear', async () => {
    const res = await get('/students/grades', 'sara')

    expect(res.body).not.toContain('g-zain-maths')
  })
})

describe('school: role boundaries', () => {
  test('a teacher’s grant does not work on the parent portal', async () => {
    const res = await get('/parents/grades', 'teacher-maths')

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ACCESS_DENIED')
  })

  test('a student’s grant does not work on the teacher portal', async () => {
    const res = await get('/teachers/grades', 'sara')

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ACCESS_DENIED')
  })

  test('the office panel declares no scopes, so its superuser sees every grade', async () => {
    const res = await get('/admin/grades', 'principal', { 'x-admin': '1' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      'g-omar-maths',
      'g-sara-art',
      'g-sara-maths',
      'g-zain-art',
      'g-zain-maths',
    ])
  })
})
