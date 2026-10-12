/**
 * Show what the 2026-10-12 target-model migration would touch, WITHOUT
 * writing anything (spec §6 / §8; `src/core/db/migrate-deadline-targets.ts`).
 *
 * Opens the database READ-ONLY and prints, per step, the count and the task
 * ids (ids only — never titles):
 *   occurrenceSeed          repeating tasks given `occurrence_at`
 *   nagOffToAuto            one-offs with `deadline_nag_off` and no target → automatic target
 *   nagOffKeptTarget        one-offs with `deadline_nag_off` and a target → kept, picked; flag cleared
 *   deadlineNoTargetToAuto  one-offs with a deadline and no target → automatic target
 *   pullBackToDeadline      targets after a deadline still ahead → pulled back to it
 *
 * Works on a database from before this build (no new columns yet) and on one
 * already migrated (all empty — the steps are idempotent). Run it against a
 * copy, never the live file (take it with `.backup` — `cp` misses WAL writes):
 *   npx tsx scripts/count-target-migration.ts /path/to/copy.db
 */
import Database from 'better-sqlite3'
import { countsOf, planDeadlineTargetMigration } from '../src/core/db/migrate-deadline-targets'

const file = process.argv[2]
if (!file) {
  console.error('Usage: npx tsx scripts/count-target-migration.ts <database file>')
  process.exit(1)
}

const db = new Database(file, { readonly: true, fileMustExist: true })
const plan = planDeadlineTargetMigration(db)
console.log(JSON.stringify({ counts: countsOf(plan), ids: plan }, null, 2))
db.close()
