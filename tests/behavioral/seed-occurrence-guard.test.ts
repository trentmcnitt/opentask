/**
 * SEEDS LEAVE NO ROW FOR THE STARTUP DATA STEPS TO PATCH (2026-10-26).
 *
 * `createTask` writes `occurrence_at` on every repeating task; the seeds
 * used to write their rows with raw SQL and leave it NULL, so a seeded repeat
 * scheduled from `due_at` alone until the server's next start ran the
 * occurrence seed (`migrateDeadlineTargets` step 1) — on production, the demo
 * account after every 4-hourly reset. Each seed runs here into a fresh
 * database and must leave nothing for that step: no row matches
 * `OCCURRENCE_SEED_WHERE`, and the migration's own plan counts 0.
 *
 * Also pinned: a seed never queues AI enrichment (AI is forced on here; the
 * seeds create their tasks with `enrichment: false`), and a seed leaves no
 * undo or activity entries of its own, so a demo visitor's first Undo cannot
 * delete a seeded task.
 */

import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getDb, resetDb } from '@/core/db'
import { OCCURRENCE_SEED_WHERE } from '@/core/db/occurrence-seed'
import { planDeadlineTargetMigration } from '@/core/db/migrate-deadline-targets'
import { seedTestData } from '../../scripts/seed-test'
import { seedDemoUser } from '../../scripts/seed-demo'
import { seedDevUser } from '../../scripts/seed-dev'
import { seedScreenshotAccount } from '../../scripts/screenshots/seed'
import { seedE2eDatabase } from '../e2e/globalSetup'

// AI on, so a seeded title-only task WOULD get `ai-to-process` if a seed let it.
vi.mock('@/core/ai/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/ai/sdk')>()),
  isAIEnabled: () => true,
}))

/** What the occurrence seed would still have to patch, plus the other leftovers. */
function leftovers(db: Database.Database) {
  const rows = db.prepare(`SELECT t.id, t.title FROM tasks t WHERE ${OCCURRENCE_SEED_WHERE}`).all()
  const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c
  return {
    occurrenceRows: rows,
    planOccurrenceSeed: planDeadlineTargetMigration(db).occurrenceSeed.length,
    aiToProcess: count(`SELECT COUNT(*) c FROM tasks WHERE labels LIKE '%"ai-to-process"%'`),
    undoEntries: count('SELECT COUNT(*) c FROM undo_log'),
    activityEntries: count('SELECT COUNT(*) c FROM activity_log'),
  }
}

const CLEAN = {
  occurrenceRows: [],
  planOccurrenceSeed: 0,
  aiToProcess: 0,
  undoEntries: 0,
  activityEntries: 0,
}

/** Some repeating ordinary tasks were seeded, so the check is not vacuous. */
function repeatingCount(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) c FROM tasks WHERE rrule IS NOT NULL AND due_at IS NOT NULL
           AND is_reminder = 0 AND is_tracked = 0`,
      )
      .get() as { c: number }
  ).c
}

describe('seeds leave nothing for the occurrence seed', () => {
  // Seeds log what they make; keep the test output to the results.
  vi.spyOn(console, 'log').mockImplementation(() => {})

  afterAll(() => {
    resetDb()
  })

  it('seed-test (the integration data)', async () => {
    resetDb()
    await seedTestData()
    const db = getDb()
    expect(repeatingCount(db)).toBeGreaterThan(0)
    expect(leftovers(db)).toEqual(CLEAN)
  })

  it('seed-demo (the demo account and its 4-hourly reset)', async () => {
    resetDb()
    await seedDemoUser(getDb())
    const db = getDb()
    expect(repeatingCount(db)).toBeGreaterThan(0)
    expect(leftovers(db)).toEqual(CLEAN)
  })

  it('seed-dev', async () => {
    resetDb()
    await seedDevUser(getDb())
    const db = getDb()
    expect(repeatingCount(db)).toBeGreaterThan(0)
    expect(leftovers(db)).toEqual(CLEAN)
  })

  it('the screenshot account', async () => {
    resetDb()
    await seedScreenshotAccount(getDb())
    const db = getDb()
    expect(repeatingCount(db)).toBeGreaterThan(0)
    expect(leftovers(db)).toEqual(CLEAN)
  })

  it('the E2E global setup', async () => {
    // Its own connection, as the global setup opens one: never data/test-e2e.db.
    const db = new Database(':memory:')
    db.exec(fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'db', 'schema.sql'), 'utf-8'))
    await seedE2eDatabase(db)
    expect(repeatingCount(db)).toBeGreaterThan(0)
    expect(leftovers(db)).toEqual(CLEAN)
    db.close()
  })
})
