/**
 * Show what the deadlines-page migration would touch, WITHOUT writing
 * anything (2026-10-22; `src/core/db/migrate-deadline-leads.ts`, plan §6).
 *
 * Opens the database READ-ONLY and prints ids only — never titles:
 *   autoToLead           open one-offs on an automatic target → no target, lead day = the old auto day
 *   oneOffLead           other open one-offs with a deadline → a lead day (dormant while targeted)
 *   repeatLead           open deadline-anchored repeats with no relative target → a lead day
 *   unqueued             deadline one-offs taken out of the task queue (queued auto rows, or
 *                        target-less ones already queued)
 *   closedAuto           done / trashed / archived rows still flagged target_auto (fenced, not changed)
 *   undoEntriesWithAuto  undo entries whose snapshot holds target_auto (their tasks are fenced)
 *   repeatOffsets        A6: open deadline-anchored repeats WITH stored offsets — kept as they are;
 *                        `matchesDefault` marks offsets equal to the old default (likely defaulted)
 * plus `wouldMigrate`: whether a start with OPENTASK_TASK_QUEUE=1 would write.
 *
 * Run it against a copy, never the live file (take it with `.backup` — `cp`
 * misses WAL writes):
 *   sqlite3 /opt/opentask/data/tasks.db ".backup /tmp/tasks-copy.db"
 *   npx tsx scripts/count-deadline-leads.ts /tmp/tasks-copy.db
 */
import Database from 'better-sqlite3'
import { planDeadlineLeadMigration } from '../src/core/db/migrate-deadline-leads'

const file = process.argv[2]
if (!file) {
  console.error('Usage: npx tsx scripts/count-deadline-leads.ts <database file>')
  process.exit(1)
}

const db = new Database(file, { readonly: true, fileMustExist: true })
const plan = planDeadlineLeadMigration(db)
const counts = {
  autoToLead: plan.autoToLead.length,
  oneOffLead: plan.oneOffLead.length,
  repeatLead: plan.repeatLead.length,
  unqueued: plan.unqueued.length,
  closedAuto: plan.closedAuto.length,
  undoEntriesWithAuto: plan.undoEntriesWithAuto,
  undoTasksWithAuto: plan.undoTaskIdsWithAuto.length,
  repeatOffsets: plan.repeatOffsets.length,
  repeatOffsetsMatchingDefault: plan.repeatOffsets.filter((r) => r.matchesDefault).length,
}
const wouldMigrate = counts.autoToLead + counts.oneOffLead + counts.repeatLead + counts.unqueued > 0
console.log(JSON.stringify({ counts, wouldMigrate, ids: plan }, null, 2))
db.close()
