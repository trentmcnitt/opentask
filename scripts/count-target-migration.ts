/**
 * Count what the 2026-10-12 target-model migration would touch, WITHOUT
 * writing anything (spec §6 / §8; `src/core/db/migrate-deadline-targets.ts`).
 *
 * Opens the database READ-ONLY and prints one count per step:
 *   occurrenceSeed          repeating tasks given `occurrence_at`
 *   nagOffToAuto            one-offs with `deadline_nag_off` → automatic target
 *   deadlineNoTargetToAuto  one-offs with a deadline and no target → automatic target
 *   pullBackToDeadline      targets after their deadline → pulled back to it
 *
 * Works on a database from before this build (no new columns yet) and on one
 * already migrated (all 0 — the steps are idempotent). Run it against a copy,
 * never the live file (take it with `.backup` — `cp` misses WAL writes):
 *   npx tsx scripts/count-target-migration.ts /path/to/copy.db
 */
import Database from 'better-sqlite3'
import { planDeadlineTargetMigration } from '../src/core/db/migrate-deadline-targets'

const file = process.argv[2]
if (!file) {
  console.error('Usage: npx tsx scripts/count-target-migration.ts <database file>')
  process.exit(1)
}

const db = new Database(file, { readonly: true, fileMustExist: true })
console.log(JSON.stringify(planDeadlineTargetMigration(db), null, 2))
db.close()
