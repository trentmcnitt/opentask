import { createHash } from 'crypto'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { SYSTEM_LABELS } from '@/lib/label-vocabulary'
import { log } from '@/lib/logger'
import { openTaskDayOf } from '@/lib/opentask-day'
import { dayStartTimeOf } from '@/lib/anchor-times'
import { migrateDeadlineTargets, type TargetMigrationCounts } from './migrate-deadline-targets'
import { migrateRepeatAnchors, type RepeatAnchorCounts } from './migrate-repeat-anchor'
import { migrateDeadlineLeads } from './migrate-deadline-leads'
import { taskQueueEnabled } from '@/core/tasks/task-queue'
import { isServerProcess } from './process-role'

const DB_PATH = process.env.OPENTASK_DB_PATH || path.join(process.cwd(), 'data', 'tasks.db')

// Singleton database instance
let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) {
    return db
  }

  // Ensure the data directory exists
  const dataDir = path.dirname(DB_PATH)
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  // Create database connection with WAL mode for better concurrent performance
  db = new Database(DB_PATH)

  // Enable WAL mode and set pragmas for performance and safety
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000') // 5 second timeout for locks
  db.pragma('synchronous = NORMAL') // Balance between safety and performance
  db.pragma('foreign_keys = ON') // Enforce foreign key constraints

  // Initialize schema
  initSchema(db)

  return db
}

/**
 * Quota reminders (2026-09-24) — see src/core/tasks/quota-prompts.ts. Its own
 * function only to keep `runMigrations` from growing further.
 *
 * NULL config means "the defaults for this quota's period", which is ON for
 * every existing daily/weekly/monthly quota — the same default for all users.
 */
function migrateQuotaPrompts(database: Database.Database): void {
  if (!hasColumn(database, 'tasks', 'quota_prompt_config')) {
    database.exec('ALTER TABLE tasks ADD COLUMN quota_prompt_config TEXT DEFAULT NULL')
  }
  if (!hasColumn(database, 'tasks', 'quota_day_state')) {
    database.exec('ALTER TABLE tasks ADD COLUMN quota_day_state TEXT DEFAULT NULL')
  }
  if (!hasColumn(database, 'users', 'quota_prompt_slot_id')) {
    database.exec('ALTER TABLE users ADD COLUMN quota_prompt_slot_id INTEGER DEFAULT NULL')
  }
  if (!hasColumn(database, 'users', 'quota_prompts_enabled')) {
    database.exec('ALTER TABLE users ADD COLUMN quota_prompts_enabled INTEGER NOT NULL DEFAULT 1')
  }
}

/**
 * The user's switches for the quiet notifications: the "AI finished" push for
 * a just-added task (2026-09-29, src/core/notifications/enrichment-notify.ts)
 * and the bulk snooze feedback push (sweep-feedback.ts). Both on by default. A
 * function only to keep `runMigrations` from growing further.
 */
function migrateEnrichmentNotifications(database: Database.Database): void {
  if (!hasColumn(database, 'users', 'enrichment_notifications_enabled')) {
    database.exec(
      'ALTER TABLE users ADD COLUMN enrichment_notifications_enabled INTEGER NOT NULL DEFAULT 1',
    )
  }
  // The bulk snooze feedback push (2026-10-04,
  // src/core/notifications/sweep-feedback.ts). On by default too.
  if (!hasColumn(database, 'users', 'sweep_feedback_notifications_enabled')) {
    database.exec(
      'ALTER TABLE users ADD COLUMN sweep_feedback_notifications_enabled INTEGER NOT NULL DEFAULT 1',
    )
  }
}

/**
 * Anchor times (2026-10-21, `src/lib/anchor-times.ts`): Morning, Wake and
 * Sleep may each link to a reminder period (`*_slot_id`, NULL = custom), and
 * the number pad's four buttons are a setting (`pad_presets`, NULL = the four
 * it always had). No backfill: NULL everywhere reads exactly as before.
 */
function migrateAnchorTimes(database: Database.Database): void {
  for (const column of ['morning_slot_id', 'wake_slot_id', 'sleep_slot_id']) {
    if (!hasColumn(database, 'users', column)) {
      database.exec(`ALTER TABLE users ADD COLUMN ${column} INTEGER DEFAULT NULL`)
    }
  }
  if (!hasColumn(database, 'users', 'pad_presets')) {
    database.exec('ALTER TABLE users ADD COLUMN pad_presets TEXT DEFAULT NULL')
  }
  // "Day starts at" (2026-10-23): both NULL = the first period's start, the
  // rollover every user had before, so no backfill.
  for (const column of ['day_start_time TEXT', 'day_start_slot_id INTEGER']) {
    const [name] = column.split(' ')
    if (!hasColumn(database, 'users', name)) {
      database.exec(`ALTER TABLE users ADD COLUMN ${column} DEFAULT NULL`)
    }
  }
}

function hasColumn(database: Database.Database, table: string, column: string): boolean {
  const cols = database.pragma(`table_info(${table})`) as { name: string }[]
  return cols.some((c) => c.name === column)
}

/**
 * Run migrations for existing databases that need new columns.
 * Each migration uses hasColumn() to be idempotent.
 */
function runMigrations(database: Database.Database): void {
  // AI UX refactor: new preference columns (2026-02)
  if (!hasColumn(database, 'users', 'ai_wn_commentary_unfiltered')) {
    database.exec(
      'ALTER TABLE users ADD COLUMN ai_wn_commentary_unfiltered INTEGER NOT NULL DEFAULT 0',
    )
    // Preserve existing behavior: users who had WN annotations on should see them without filtering
    database.exec('UPDATE users SET ai_wn_commentary_unfiltered = 1 WHERE ai_show_whats_next = 1')
  }
  if (!hasColumn(database, 'users', 'ai_wn_highlight')) {
    database.exec('ALTER TABLE users ADD COLUMN ai_wn_highlight INTEGER NOT NULL DEFAULT 1')
  }
  if (!hasColumn(database, 'users', 'ai_insights_signal_chips')) {
    database.exec(
      'ALTER TABLE users ADD COLUMN ai_insights_signal_chips INTEGER NOT NULL DEFAULT 1',
    )
  }
  if (!hasColumn(database, 'users', 'ai_insights_score_chips')) {
    database.exec('ALTER TABLE users ADD COLUMN ai_insights_score_chips INTEGER NOT NULL DEFAULT 1')
  }
  // Quick Take user toggle (2026-02). VESTIGIAL: nothing reads or writes it
  // any more; kept rather than dropped (no destructive migration).
  if (!hasColumn(database, 'users', 'ai_quick_take')) {
    database.exec('ALTER TABLE users ADD COLUMN ai_quick_take INTEGER NOT NULL DEFAULT 0')
  }
  // Priority-based notification intervals (2026-02)
  if (!hasColumn(database, 'users', 'auto_snooze_urgent_minutes')) {
    database.exec(
      'ALTER TABLE users ADD COLUMN auto_snooze_urgent_minutes INTEGER NOT NULL DEFAULT 5',
    )
  }
  if (!hasColumn(database, 'users', 'auto_snooze_high_minutes')) {
    database.exec(
      'ALTER TABLE users ADD COLUMN auto_snooze_high_minutes INTEGER NOT NULL DEFAULT 15',
    )
  }
  // Independent cooldown for critical alerts (2026-02)
  if (!hasColumn(database, 'tasks', 'last_critical_alert_at')) {
    database.exec('ALTER TABLE tasks ADD COLUMN last_critical_alert_at TEXT')
  }
  // Per-user notification toggle (2026-02)
  if (!hasColumn(database, 'users', 'notifications_enabled')) {
    database.exec('ALTER TABLE users ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1')
  }
  migrateEnrichmentNotifications(database)
  migrateAnchorTimes(database)
  // Project colors (2026-02)
  if (!hasColumn(database, 'projects', 'color')) {
    database.exec('ALTER TABLE projects ADD COLUMN color TEXT')
  }
  // Critical alert volume (2026-02)
  if (!hasColumn(database, 'users', 'critical_alert_volume')) {
    database.exec('ALTER TABLE users ADD COLUMN critical_alert_volume REAL NOT NULL DEFAULT 1.0')
  }
  // AI provider selection (2026-03). VESTIGIAL: nothing reads or writes it
  // now except the one-time per-feature mode backfill below, which needs the
  // column to exist. Kept rather than dropped (no destructive migration).
  if (!hasColumn(database, 'users', 'ai_provider')) {
    database.exec("ALTER TABLE users ADD COLUMN ai_provider TEXT NOT NULL DEFAULT 'default'")
  }
  // Insights session heartbeat (2026-10-21): a long chunked run is judged
  // stale by time since its last chunk, not since it started
  if (!hasColumn(database, 'ai_insights_sessions', 'heartbeat_at')) {
    database.exec('ALTER TABLE ai_insights_sessions ADD COLUMN heartbeat_at TEXT')
  }
  if (!hasColumn(database, 'ai_activity_log', 'provider')) {
    database.exec('ALTER TABLE ai_activity_log ADD COLUMN provider TEXT')
  }
  // Per-feature AI backend modes (2026-03)
  if (!hasColumn(database, 'users', 'ai_enrichment_mode')) {
    database.exec("ALTER TABLE users ADD COLUMN ai_enrichment_mode TEXT NOT NULL DEFAULT 'api'")
    database.exec("ALTER TABLE users ADD COLUMN ai_quicktake_mode TEXT NOT NULL DEFAULT 'api'")
    database.exec("ALTER TABLE users ADD COLUMN ai_whats_next_mode TEXT NOT NULL DEFAULT 'api'")
    database.exec("ALTER TABLE users ADD COLUMN ai_insights_mode TEXT NOT NULL DEFAULT 'api'")
    // Migrate from old ai_provider column: sdk → sdk, anthropic/openai/default → api
    database.exec(
      `UPDATE users SET
        ai_enrichment_mode = CASE WHEN ai_provider = 'sdk' THEN 'sdk' ELSE 'api' END,
        ai_quicktake_mode = CASE WHEN ai_provider = 'sdk' THEN 'sdk' ELSE 'api' END,
        ai_whats_next_mode = CASE WHEN ai_provider = 'sdk' THEN 'sdk' ELSE 'api' END,
        ai_insights_mode = CASE WHEN ai_provider = 'sdk' THEN 'sdk' ELSE 'api' END`,
    )
    // Migrate visibility toggles: show=0 → mode='off'
    database.exec("UPDATE users SET ai_whats_next_mode = 'off' WHERE ai_show_whats_next = 0")
    database.exec("UPDATE users SET ai_insights_mode = 'off' WHERE ai_show_insights = 0")
    database.exec("UPDATE users SET ai_quicktake_mode = 'off' WHERE ai_show_commentary = 0")
  }
  // Process's own AI mode (2026-10-22). Process (src/core/ai/process.ts) read
  // the Insights mode until the AI shelve hid the Insights row, so the column
  // starts as a copy of each user's Insights mode — nobody's Process
  // behaviour changes. Inside the guard, so it runs once: later Insights
  // changes never touch it.
  if (!hasColumn(database, 'users', 'ai_process_mode')) {
    database.exec("ALTER TABLE users ADD COLUMN ai_process_mode TEXT NOT NULL DEFAULT 'api'")
    database.exec('UPDATE users SET ai_process_mode = ai_insights_mode')
  }
  // Per-user AI query timeout (2026-03) — vestigial, kept for existing DBs
  if (!hasColumn(database, 'users', 'ai_query_timeout_ms')) {
    database.exec('ALTER TABLE users ADD COLUMN ai_query_timeout_ms INTEGER')
  }
  // Per-feature per-user AI query timeouts (2026-03)
  if (!hasColumn(database, 'users', 'ai_enrichment_timeout_ms')) {
    database.exec('ALTER TABLE users ADD COLUMN ai_enrichment_timeout_ms INTEGER')
    database.exec('ALTER TABLE users ADD COLUMN ai_quicktake_timeout_ms INTEGER')
    database.exec('ALTER TABLE users ADD COLUMN ai_whats_next_timeout_ms INTEGER')
    database.exec('ALTER TABLE users ADD COLUMN ai_insights_timeout_ms INTEGER')
    // Migrate: copy old global timeout to the two features that respected it.
    // Quick Take (hardcoded 40s) and Insights (hardcoded 15min) were never affected.
    database.exec(`UPDATE users SET
      ai_enrichment_timeout_ms = ai_query_timeout_ms,
      ai_whats_next_timeout_ms = ai_query_timeout_ms
      WHERE ai_query_timeout_ms IS NOT NULL`)
  }
  // Demo user flag (2026-03)
  if (!hasColumn(database, 'users', 'is_demo')) {
    database.exec('ALTER TABLE users ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0')
  }
  // Auto-set flag for existing demo users (idempotent)
  database.exec("UPDATE users SET is_demo = 1 WHERE LOWER(name) = 'demo' AND is_demo = 0")

  // Sort order persistence (2026-03)
  if (!hasColumn(database, 'users', 'default_sort')) {
    database.exec("ALTER TABLE users ADD COLUMN default_sort TEXT NOT NULL DEFAULT 'horizon'")
  }
  if (!hasColumn(database, 'users', 'default_sort_reversed')) {
    database.exec('ALTER TABLE users ADD COLUMN default_sort_reversed INTEGER NOT NULL DEFAULT 0')
  }

  // iOS auto-provisioned token source tracking (2026-03)
  if (!hasColumn(database, 'api_tokens', 'source')) {
    database.exec("ALTER TABLE api_tokens ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
  }

  // Token hashing: add token_preview column and hash existing plaintext tokens (2026-02)
  if (!hasColumn(database, 'api_tokens', 'token_preview')) {
    database.exec('ALTER TABLE api_tokens ADD COLUMN token_preview TEXT')
    // Migrate existing plaintext tokens to SHA-256 hashes
    const tokens = database.prepare('SELECT id, token FROM api_tokens').all() as {
      id: number
      token: string
    }[]
    const update = database.prepare(
      'UPDATE api_tokens SET token = ?, token_preview = ? WHERE id = ?',
    )
    for (const row of tokens) {
      // Only hash if it looks like a plaintext token (64 hex chars from randomBytes(32))
      // SHA-256 hashes are also 64 hex chars, so we use a heuristic: if token_preview
      // is already set, it was already migrated. Since we just added the column, all
      // rows have NULL token_preview, so all will be migrated.
      const preview = row.token.slice(-8)
      const hashed = createHash('sha256').update(row.token).digest('hex')
      update.run(hashed, preview, row.id)
    }
  }

  // Track / quotas + skip (REDESIGN-V03 §5, §7.5)
  if (!hasColumn(database, 'tasks', 'progress_target')) {
    database.exec('ALTER TABLE tasks ADD COLUMN progress_target INTEGER NOT NULL DEFAULT 1')
  }
  if (!hasColumn(database, 'tasks', 'progress_current')) {
    database.exec('ALTER TABLE tasks ADD COLUMN progress_current INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn(database, 'tasks', 'skip_count')) {
    database.exec('ALTER TABLE tasks ADD COLUMN skip_count INTEGER NOT NULL DEFAULT 0')
  }
  // §4.1 cadence ladder: P1 and P2 get their own intervals
  if (!hasColumn(database, 'users', 'auto_snooze_low_minutes')) {
    database.exec(
      'ALTER TABLE users ADD COLUMN auto_snooze_low_minutes INTEGER NOT NULL DEFAULT 240',
    )
  }
  if (!hasColumn(database, 'users', 'auto_snooze_medium_minutes')) {
    database.exec(
      'ALTER TABLE users ADD COLUMN auto_snooze_medium_minutes INTEGER NOT NULL DEFAULT 60',
    )
  }

  // Reminders surface (§6)
  if (!hasColumn(database, 'tasks', 'is_reminder')) {
    database.exec('ALTER TABLE tasks ADD COLUMN is_reminder INTEGER NOT NULL DEFAULT 0')
  }
  // §5: explicit tracked flag (2026-09-05, "1 date night a month"). Existing
  // quotas are marked so the flag is the single source of truth going forward.
  if (!hasColumn(database, 'tasks', 'is_tracked')) {
    database.exec('ALTER TABLE tasks ADD COLUMN is_tracked INTEGER NOT NULL DEFAULT 0')
    database.exec('UPDATE tasks SET is_tracked = 1 WHERE progress_target > 1')
  }
  // §5: the period rollover's anchor (see src/core/tasks/period-rollover.ts).
  if (!hasColumn(database, 'tasks', 'progress_period_start')) {
    database.exec('ALTER TABLE tasks ADD COLUMN progress_period_start TEXT')
  }
  migrateQuotaPrompts(database)

  // Collapsible dashboard filter chips (§7.3) — default collapsed for everyone,
  // including existing users: the whole point is that the front door stops
  // opening onto a wall of chips.
  if (!hasColumn(database, 'users', 'filters_expanded')) {
    database.exec('ALTER TABLE users ADD COLUMN filters_expanded INTEGER NOT NULL DEFAULT 0')
  }
  // §5: the Track panel folds to one line by default (Trent, 2026-09-05: the
  // open panel pushed the first task of the day below the fold on a phone).
  if (!hasColumn(database, 'users', 'track_expanded')) {
    database.exec('ALTER TABLE users ADD COLUMN track_expanded INTEGER NOT NULL DEFAULT 0')
  }
  // §5: /quotas opens on the summary (the dashboard's Quotas panel) unless the
  // user chose the detailed list (Trent, 2026-09-25). Unread since 2026-10-16,
  // when the detailed list went; kept for the preferences API.
  if (!hasColumn(database, 'users', 'quotas_details')) {
    database.exec('ALTER TABLE users ADD COLUMN quotas_details INTEGER NOT NULL DEFAULT 0')
  }
  // What a plain press of the bulk-snooze clock does (Trent, 2026-09-22): to
  // the next time slot by default, or the user's default snooze option. A
  // setting so he can flip between the two while deciding.
  if (!hasColumn(database, 'users', 'bulk_snooze_default')) {
    database.exec(
      "ALTER TABLE users ADD COLUMN bulk_snooze_default TEXT NOT NULL DEFAULT 'next_period'",
    )
  }
  // First day of the user's week (Trent, 2026-09-27: Sunday, so Saturday is
  // the last day for the week's quotas). Existing users get 'sunday' too; their
  // Monday-anchored weekly quotas close at the next Sunday boundary on the next
  // rollover pass — see `quotaPeriodEnd` in src/lib/week-start.ts.
  if (!hasColumn(database, 'users', 'week_start')) {
    database.exec("ALTER TABLE users ADD COLUMN week_start TEXT NOT NULL DEFAULT 'sunday'")
  }
  // Short label for the quota widget chip (§5, Trent 2026-09-23): quota
  // titles are often long sentences, and the widget needs something that
  // fits on a small tappable chip.
  if (!hasColumn(database, 'tasks', 'short_title')) {
    database.exec('ALTER TABLE tasks ADD COLUMN short_title TEXT DEFAULT NULL')
  }
  // Editable time slots (2026-09-24): an undo entry for a slot edit/delete
  // carries the slot row itself, so undo restores the slot WITH the reminders
  // it moved (see src/core/time-slots/edit.ts).
  if (!hasColumn(database, 'undo_log', 'slot_state')) {
    database.exec('ALTER TABLE undo_log ADD COLUMN slot_state TEXT DEFAULT NULL')
  }
  // How many tasks each project group in the All view (since 2026-10-14: Now
  // with its folds lifted) shows before "Show all" (2026-09-30). Existing users get the default 6 too.
  if (!hasColumn(database, 'users', 'project_preview_count')) {
    database.exec('ALTER TABLE users ADD COLUMN project_preview_count INTEGER NOT NULL DEFAULT 6')
  }

  // Task model (2026-10-10): deadline, horizon and the task-segment stamps.
  // See docs/TASK-MODEL.md § Deadline, target, horizon.
  for (const col of [
    'deadline_at',
    'horizon',
    'horizon_set_at',
    'last_considered_at',
    'segment_deferred_at',
    // 2026-10-12: targeted from a task segment (Today / its time picker).
    'segment_targeted_at',
  ]) {
    if (!hasColumn(database, 'tasks', col)) {
      database.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT DEFAULT NULL`)
    }
  }
  // Upcoming (2026-10-12): when the target was last set by any path. Seeded
  // ONCE, as the column arrives, with what a null reads as (created_at; a
  // repeating task's latest completion if later) — see targetSetAtOf in
  // src/lib/task-segments.ts. Rows written later without it read the same way.
  if (!hasColumn(database, 'tasks', 'target_set_at')) {
    database.exec('ALTER TABLE tasks ADD COLUMN target_set_at TEXT DEFAULT NULL')
    database.exec(
      `UPDATE tasks SET target_set_at = CASE
         WHEN rrule IS NOT NULL AND last_completed_at IS NOT NULL AND last_completed_at > created_at
           THEN last_completed_at
         ELSE created_at END
       WHERE target_set_at IS NULL`,
    )
  }
  // The horizon segments' weekday (2026-10-12), 1 = Monday … 7 = Sunday.
  // Existing users keep Saturday, the day the segments have always used.
  if (!hasColumn(database, 'users', 'check_in_day')) {
    database.exec('ALTER TABLE users ADD COLUMN check_in_day INTEGER NOT NULL DEFAULT 6')
  }
  if (!hasColumn(database, 'tasks', 'deadline_nag_off')) {
    database.exec('ALTER TABLE tasks ADD COLUMN deadline_nag_off INTEGER NOT NULL DEFAULT 0')
  }
  // §8 / §6 (2026-10-12): the stored automatic deadline target, a repeating
  // task's scheduled occurrence, and the occurrence a completion row closed.
  if (!hasColumn(database, 'tasks', 'target_auto')) {
    database.exec('ALTER TABLE tasks ADD COLUMN target_auto INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn(database, 'tasks', 'occurrence_at')) {
    database.exec('ALTER TABLE tasks ADD COLUMN occurrence_at TEXT DEFAULT NULL')
  }
  if (!hasColumn(database, 'completions', 'occurrence_at_was')) {
    database.exec('ALTER TABLE completions ADD COLUMN occurrence_at_was TEXT DEFAULT NULL')
  }
  // The two badges (spec §7, 2026-10-12). Attempts start at 0 with no
  // checkpoint: the read then counts the over-target days of the CURRENT
  // target (from its local day, never before the task existed) — the honest
  // part of the history that is recoverable. Earlier targets' days are lost.
  if (!hasColumn(database, 'tasks', 'attempts')) {
    database.exec('ALTER TABLE tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0')
  }
  for (const col of ['attempts_counted_through', 'growth_kept_at']) {
    if (!hasColumn(database, 'tasks', col)) {
      database.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT DEFAULT NULL`)
    }
  }
  // The task queue (2026-10-19, docs/TASK-MODEL.md § Picks and defers).
  for (const col of ['queue_mark', 'try_tomorrow']) {
    if (!hasColumn(database, 'tasks', col)) {
      database.exec(`ALTER TABLE tasks ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`)
    }
  }
  for (const col of ['queued_at', 'queued_from_due_at']) {
    if (!hasColumn(database, 'tasks', col)) {
      database.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT DEFAULT NULL`)
    }
  }
  // Written by the rollover (task-queue PR 2); stamped below
  // (`stampRolloverDates`) — NULL is never read as "never ran".
  if (!hasColumn(database, 'users', 'last_rollover_date')) {
    database.exec('ALTER TABLE users ADD COLUMN last_rollover_date TEXT DEFAULT NULL')
  }
  // The rollover's undo-fence witness (task-queue PR 2).
  if (!hasColumn(database, 'tasks', 'rolled_over_at')) {
    database.exec('ALTER TABLE tasks ADD COLUMN rolled_over_at TEXT DEFAULT NULL')
  }
  // On deck (2026-10-20, docs/TASK-MODEL.md § On deck). No backfill.
  for (const col of ['on_deck_day', 'queued_from_deck_day']) {
    if (!hasColumn(database, 'tasks', col)) {
      database.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT DEFAULT NULL`)
    }
  }
  // A quota's transition period ("Day starts at" PR 2, 2026-10-24): closed
  // early because its anchor was not on a period start. No backfill.
  if (!hasColumn(database, 'progress_periods', 'transition')) {
    database.exec('ALTER TABLE progress_periods ADD COLUMN transition INTEGER NOT NULL DEFAULT 0')
  }
  // The day roster's explicit "how it left" (2026-10-22, the deadlines page's Defer).
  if (!hasColumn(database, 'segment_roster', 'left_how')) {
    database.exec('ALTER TABLE segment_roster ADD COLUMN left_how TEXT DEFAULT NULL')
  }
  // The day roster's Upcoming section (2026-10-25, the Upcoming split). No
  // backfill: a NULL reads as the section computed now.
  if (!hasColumn(database, 'segment_roster', 'section')) {
    database.exec('ALTER TABLE segment_roster ADD COLUMN section TEXT DEFAULT NULL')
  }
  // The deadlines page (2026-10-22). Backfilled by `migrateDeadlineLeads`
  // (task-queue switch on).
  if (!hasColumn(database, 'tasks', 'lead_days')) {
    database.exec('ALTER TABLE tasks ADD COLUMN lead_days INTEGER DEFAULT NULL')
  }
  if (!hasColumn(database, 'tasks', 'lead_from')) {
    database.exec('ALTER TABLE tasks ADD COLUMN lead_from TEXT DEFAULT NULL')
  }
  // Deadline-anchored repeats (2026-10-21). NOT NULL DEFAULT 'target': every
  // existing repeat is target-anchored as it stands, so no backfill — the one
  // data step is `migrateRepeatAnchors`, for repeats that carry a deadline.
  if (!hasColumn(database, 'tasks', 'repeat_anchor')) {
    database.exec(
      `ALTER TABLE tasks ADD COLUMN repeat_anchor TEXT NOT NULL DEFAULT 'target'
         CHECK (repeat_anchor IN ('target', 'deadline'))`,
    )
  }
  if (!hasColumn(database, 'tasks', 'target_days_before')) {
    database.exec('ALTER TABLE tasks ADD COLUMN target_days_before INTEGER DEFAULT NULL')
  }
  if (!hasColumn(database, 'tasks', 'target_time')) {
    database.exec('ALTER TABLE tasks ADD COLUMN target_time TEXT DEFAULT NULL')
  }
  // Relative targets (2026-10-24): the period a relative target's time follows.
  // No backfill: an existing row's time is custom (NULL).
  if (!hasColumn(database, 'tasks', 'target_slot_id')) {
    database.exec('ALTER TABLE tasks ADD COLUMN target_slot_id INTEGER DEFAULT NULL')
  }
  database.exec(
    'CREATE INDEX IF NOT EXISTS idx_tasks_target_slot ON tasks(target_slot_id) WHERE target_slot_id IS NOT NULL',
  )
  // Repeat ends (2026-10-22, docs/TASK-MODEL.md § Repeat ends). No backfill
  // beyond `liftRuleEnds` below: a rule stored with COUNT/UNTIL (none on prod).
  if (!hasColumn(database, 'tasks', 'repeat_count')) {
    database.exec('ALTER TABLE tasks ADD COLUMN repeat_count INTEGER DEFAULT NULL')
  }
  if (!hasColumn(database, 'tasks', 'repeat_count_used')) {
    database.exec('ALTER TABLE tasks ADD COLUMN repeat_count_used INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn(database, 'tasks', 'repeat_until')) {
    database.exec('ALTER TABLE tasks ADD COLUMN repeat_until TEXT DEFAULT NULL')
  }
  if (!hasColumn(database, 'completions', 'occurrence_at_next')) {
    database.exec('ALTER TABLE completions ADD COLUMN occurrence_at_next TEXT DEFAULT NULL')
  }
  if (!hasColumn(database, 'completions', 'attempts')) {
    database.exec('ALTER TABLE completions ADD COLUMN attempts INTEGER DEFAULT NULL')
  }
  if (!hasColumn(database, 'projects', 'description')) {
    database.exec('ALTER TABLE projects ADD COLUMN description TEXT DEFAULT NULL')
  }
  if (!hasColumn(database, 'users', 'ai_context_updated_at')) {
    database.exec('ALTER TABLE users ADD COLUMN ai_context_updated_at TEXT DEFAULT NULL')
  }
  // Where a quota's progress was logged from (src/lib/progress-source.ts).
  // Rows from before it are 'unknown': the source was never recorded, and the
  // column default ('api', what a caller that says nothing is) would claim
  // they came from the API. Only rows that exist when the column is added.
  if (!hasColumn(database, 'progress_events', 'source')) {
    database.exec("ALTER TABLE progress_events ADD COLUMN source TEXT NOT NULL DEFAULT 'api'")
    database.exec("UPDATE progress_events SET source = 'unknown'")
  }

  // Client attribution (2026-10-20): which client made each logged write
  // (`src/lib/client-attribution.ts`), and when each token was last used.
  // Rows from before stay NULL: the client was never recorded.
  for (const table of ['activity_log', 'undo_log']) {
    for (const column of ['client', 'token_name']) {
      if (!hasColumn(database, table, column)) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT DEFAULT NULL`)
      }
    }
  }
  if (!hasColumn(database, 'api_tokens', 'last_used_at')) {
    database.exec('ALTER TABLE api_tokens ADD COLUMN last_used_at TEXT DEFAULT NULL')
  }

  // Before the backfill, which would re-register a task's leftover copy.
  const retired = retireAiLockedLabel(database)
  if (retired.registry > 0 || retired.tasks > 0) {
    log.info(
      'db',
      `ai-locked retired (2026-10-28): ${retired.registry} registry row(s), ` +
        `stripped from ${retired.tasks} task(s)`,
    )
  }
  backfillLabelRegistry(database)
  backfillTimeSlots(database)
  // After the periods are backfilled: the rollover time is the first period.
  stampRolloverDates(database)
  clearQuotaDueDates(database)
  restoreProjectGrouping(database)
  // The deadline data steps: the two that read the task-queue switch run in
  // the SERVER only — a script skips them in both directions and leaves them
  // to the server's next start (`runDeadlineSteps`, process-role.ts).
  runDeadlineSteps(database)
  // After the end columns exist (above).
  const ends = liftRuleEnds(database)
  if (ends.lifted > 0 || ends.stripped.length > 0) {
    log.info(
      'db',
      `repeat ends (2026-10-22): lifted ${ends.lifted} rule end(s) into columns; ` +
        `stripped from reminders/quotas: ${JSON.stringify(ends.stripped)}`,
    )
  }
}

/**
 * THE SWITCH-DEPENDENT DATA STEPS RUN IN THE SERVER ONLY (2026-10-24).
 * The deadlines page (2026-10-22, plan A1/L7) rides the task-queue switch
 * (`taskQueueEnabled()`, OPENTASK_TASK_QUEUE): on, no automatic target is
 * created at startup and `migrateDeadlineLeads` turns any left into leads;
 * off, the automatic target is stored. The switch lives in the SERVER's
 * environment — a script opening the same database (the 4-hourly demo
 * reset, create-token, the seeds) runs without it, and used to re-create
 * an automatic target on every deadline one-off the deadlines page held
 * (prod, 10-24), which the server's next start converted back. So:
 *  - the server (`isServerProcess()`, marked first thing in
 *    instrumentation's register(), before the database opens —
 *    src/core/db/process-role.ts) runs both steps exactly as before;
 *  - any other process runs NEITHER direction: `migrateDeadlineTargets`
 *    skips its switch-dependent steps (`switchSteps: false`: the automatic
 *    targets, the nag-off flag, the target-less repeat rollback) and
 *    `migrateDeadlineLeads` does not run. The server applies them at its
 *    next start. Every other data step here runs in every process.
 * Tests that exercise these steps call them directly or mark the process.
 */
function runDeadlineSteps(database: Database.Database): void {
  const server = isServerProcess()
  const leads = taskQueueEnabled()
  if (!server) {
    log.info('db', 'not the server: the task-queue switch data steps are left to its next start')
  }
  logTargetMigration(migrateDeadlineTargets(database, new Date(), { leads, switchSteps: server }))
  // After the pull-back above: a converted row's moved target is already capped.
  logRepeatAnchorMigration(migrateRepeatAnchors(database))
  // After the anchor migration: a converted repeat keeps its offsets (A6).
  if (server && leads) {
    const leadCounts = migrateDeadlineLeads(database)
    if (Object.values(leadCounts).some((n) => n > 0)) {
      log.info('db', `deadlines page migration (2026-10-22): ${JSON.stringify(leadCounts)}`)
    }
  }
}

/**
 * REPEAT ENDS (2026-10-22, docs/TASK-MODEL.md § Repeat ends): a stored rule
 * is END-FREE — the end lives in `repeat_count` / `repeat_until`. A row
 * whose rule still carries COUNT or UNTIL (validation refused them until
 * now; another install may have some by hand or by an old import) has the
 * end LIFTED into the columns and stripped from the rule: COUNT=n →
 * `repeat_count` n (counting from now: `repeat_count_used` 0, A3), UNTIL's
 * YYYYMMDD → `repeat_until`, taken literally as the local last day. A column
 * already set wins; COUNT wins over UNTIL when a rule has both (they are
 * exclusive); a value out of range (COUNT outside 1..999, a malformed
 * UNTIL) is dropped with the rest of the end. A REMINDER or a QUOTA can't
 * have an end (`ends_kind`), so its rule's end is STRIPPED and not lifted —
 * lifted, every later edit of the row would be refused — and its id logged.
 * Idempotent: a stripped rule no longer matches. Returns the rows lifted, and
 * the ids only stripped.
 */
export function liftRuleEnds(database: Database.Database): { lifted: number; stripped: number[] } {
  const rows = database
    .prepare(
      `SELECT id, rrule, repeat_count, repeat_until, is_reminder, is_tracked, progress_target
         FROM tasks
        WHERE rrule IS NOT NULL AND (rrule LIKE '%COUNT=%' OR rrule LIKE '%UNTIL=%')`,
    )
    .all() as {
    id: number
    rrule: string
    repeat_count: number | null
    repeat_until: string | null
    is_reminder: number
    is_tracked: number
    progress_target: number
  }[]
  const write = database.prepare(
    `UPDATE tasks
        SET rrule = ?, repeat_count = ?, repeat_until = ?,
            repeat_count_used = CASE WHEN ? THEN 0 ELSE repeat_count_used END
      WHERE id = ?`,
  )
  let lifted = 0
  const stripped: number[] = []
  database.transaction(() => {
    for (const row of rows) {
      let count: number | null = null
      let until: string | null = null
      const kept: string[] = []
      for (const part of row.rrule.split(';')) {
        const [key, value = ''] = part.split('=')
        const name = key.trim().toUpperCase()
        if (name === 'COUNT') {
          const n = /^\d+$/.test(value.trim()) ? parseInt(value, 10) : NaN
          if (n >= 1 && n <= 999) count = n
        } else if (name === 'UNTIL') {
          const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})/)
          if (m) until = `${m[1]}-${m[2]}-${m[3]}`
        } else kept.push(part)
      }
      // A reminder or a quota (`isTracked`'s rule): the end goes, nothing lifted.
      if (row.is_reminder === 1 || row.is_tracked === 1 || row.progress_target > 1) {
        database.prepare('UPDATE tasks SET rrule = ? WHERE id = ?').run(kept.join(';'), row.id)
        stripped.push(row.id)
        continue
      }
      if (row.repeat_count !== null || row.repeat_until !== null) {
        count = row.repeat_count
        until = row.repeat_until
      } else if (count !== null) {
        until = null
      }
      const changedEnd = count !== row.repeat_count || until !== row.repeat_until
      write.run(kept.join(';'), count, until, changedEnd ? 1 : 0, row.id)
      lifted++
    }
  })()
  return { lifted, stripped }
}

/** Log what the deadline-anchor step did (2026-10-21), only when it did something. */
function logRepeatAnchorMigration(counts: RepeatAnchorCounts): void {
  if (counts.converted > 0 || counts.completionsRewritten > 0) {
    log.info(
      'db',
      `repeat anchor migration (2026-10-21): ${counts.converted} converted, ${counts.completionsRewritten} completions rewritten`,
    )
  }
  if (counts.skipped.length > 0) {
    log.info('db', `repeat anchor migration skipped: ${JSON.stringify(counts.skipped)}`)
  }
}

/** Log what the target-model data steps did, only when they did something. */
function logTargetMigration(counts: TargetMigrationCounts): void {
  if (Object.values(counts).some((n) => n > 0)) {
    log.info('db', `target model migration (2026-10-12): ${JSON.stringify(counts)}`)
  }
}

/**
 * THE ROLLOVER'S DEPLOY STAMP (task queue PR 2, 2026-10-19). Every user whose
 * `last_rollover_date` is NULL gets their CURRENT OpenTask day — so the first
 * deploy strips nothing, and the first strip is the next real rollover.
 * Runs on every startup, switch on or off; the `IS NULL` makes a second run a
 * no-op. The rollover job itself also treats a NULL as "stamp, don't strip"
 * (a user created after this ran), so NULL never means "never ran".
 */
export function stampRolloverDates(database: Database.Database, now: Date = new Date()): number {
  // The day start through `dayStartTimeOf` (the resolver's rule over bare
  // rows): this runs at startup, below the layer `getDayStart` lives in.
  const users = database
    .prepare(
      'SELECT id, timezone, day_start_time, day_start_slot_id FROM users WHERE last_rollover_date IS NULL',
    )
    .all() as {
    id: number
    timezone: string
    day_start_time: string | null
    day_start_slot_id: number | null
  }[]
  if (users.length === 0) return 0
  const slots = database.prepare('SELECT id, start_time FROM time_slots WHERE user_id = ?')
  const stamp = database.prepare('UPDATE users SET last_rollover_date = ? WHERE id = ?')
  let stamped = 0
  for (const u of users) {
    try {
      const time = dayStartTimeOf(u, slots.all(u.id) as { id: number; start_time: string }[])
      stamp.run(openTaskDayOf(now, u.timezone, time), u.id)
      stamped++
    } catch (err) {
      // A malformed zone or day start: left NULL, and the job stamps it
      // (or skips it) on its own. Never block startup.
      log.warn('db', `Rollover stamp skipped for user ${u.id}:`, err)
    }
  }
  return stamped
}

/**
 * Rewrite a stored retired `default_grouping` to `'project'` (Now):
 *
 * - `'time'` — the due-date grouping. The dashboard's "All" chip became the
 *   by-project grouping again on 2026-09-30; this reversed
 *   `retireProjectGrouping`, the 2026-09-29 step that rewrote every 'project'
 *   to 'time' when the Projects view was retired by mistake.
 * - `'slot'` — the Today view (§7.3), dropped on 2026-10-14 when All became
 *   Now (`src/lib/grouping.ts`).
 *
 * Every reader already coerces both to 'project' (`coerceGrouping`), so this
 * is not what makes those users land on Now; it makes the column say what
 * they see, so nothing downstream has to keep remembering the old values. It
 * also covers users created on a database whose `users` table was made while
 * the column's default was 'time': SQLite keeps that old `DEFAULT 'time'`
 * (only a fresh `schema.sql` has `DEFAULT 'project'`), so such a user holds
 * 'time' until the next start runs this again.
 *
 * Data-only and idempotent by construction — the WHERE clause matches nothing
 * once it has run — so, like `clearQuotaDueDates`, it runs on every start.
 * Exported so a behavioral test can call it directly.
 */
export function restoreProjectGrouping(database: Database.Database): void {
  database.exec(
    `UPDATE users SET default_grouping = 'project' WHERE default_grouping IN ('time', 'slot')`,
  )
}

/**
 * §5: a quota has no due date — drop the ones already stored (2026-09-08).
 *
 * Every quota in the corpus carries a `due_at` left over from the life it had
 * before it became one, and the §9 migration that rewrote quota rules to the
 * bare period ("FREQ=WEEKLY") did not touch it. It was never the period
 * boundary and was never true: on the dev corpus, 15 of 19 quotas held the
 * same date in the past while their real period anchor
 * (`progress_period_start`) sat days later. That stale date is what made a
 * quota show up as overdue debt in counts and offer a snooze grid.
 *
 * `original_due_at` goes with it: it is the occurrence origin of a due date
 * that no longer exists, and left behind it makes `is_snoozed` true in the API
 * response for a row that cannot be snoozed.
 *
 * Data-only, so there is no new column to hang a `hasColumn` guard on and no
 * migrations table in this app to record a version in. It is instead
 * idempotent by construction — the WHERE clause matches nothing once it has
 * run — and left to run on every start, where it also repairs any quota that
 * somehow acquires a date again.
 *
 * Exported so a behavioral test can call it directly.
 */
export function clearQuotaDueDates(database: Database.Database): void {
  database.exec(
    `UPDATE tasks
        SET due_at = NULL, original_due_at = NULL
      WHERE (is_tracked = 1 OR progress_target > 1)
        AND (due_at IS NOT NULL OR original_due_at IS NOT NULL)`,
  )
}

/**
 * Give every existing user the default time slots (REDESIGN-V03 §6.0).
 *
 * `seedDefaultTimeSlots` runs at user creation, but users who existed before
 * this shipped would otherwise have none — and a user with no slots gets a
 * dashboard where every item falls into the un-slotted group, which looks
 * broken rather than empty.
 *
 * Only touches users who have zero slots, so customised boundaries are never
 * clobbered.
 */
function backfillTimeSlots(database: Database.Database): void {
  // Kept in sync with DEFAULT_TIME_SLOTS in src/core/time-slots. Duplicated
  // rather than imported because that module imports getDb from here, and a
  // cycle at module-init time is exactly where it would break.
  const defaults: [string, string][] = [
    ['Early morning', '07:00'],
    // Was "Before work" — the spec's guess at the 09:00 cluster. Trent
    // (2026-09-05): "10 am is not before work… it's just morning."
    ['Morning', '09:00'],
    ['Midday', '12:00'],
    ['Afternoon', '16:00'],
    ['Evening', '20:30'],
  ]

  const insert = database.prepare(
    'INSERT INTO time_slots (user_id, label, start_time, sort_order) VALUES (?, ?, ?, ?)',
  )

  const run = database.transaction(() => {
    const users = database
      .prepare(
        `SELECT u.id FROM users u
          WHERE NOT EXISTS (SELECT 1 FROM time_slots s WHERE s.user_id = u.id)`,
      )
      .all() as { id: number }[]

    for (const user of users) {
      defaults.forEach(([label, startTime], index) => {
        insert.run(user.id, label, startTime, index)
      })
    }
  })

  run()
}

/**
 * `ai-locked` RETIRED (2026-10-28, Trent: "let's just get rid of AI locked as
 * a concept"). It only made enrichment skip a task, and no task carried it.
 * The backfill seeded it into every user's registry as system vocabulary;
 * this deletes it there (Trent approved all four accounts) and strips it from
 * any task that still has it, so the label is simply gone. Runs BEFORE the
 * backfill, which would otherwise re-register a task's copy as a domain label.
 * Idempotent: a second run finds nothing.
 */
export function retireAiLockedLabel(database: Database.Database): {
  registry: number
  tasks: number
} {
  const run = database.transaction(() => {
    const rows = database
      .prepare(
        `SELECT id, labels FROM tasks
         WHERE EXISTS (SELECT 1 FROM json_each(labels) WHERE value = 'ai-locked')`,
      )
      .all() as { id: number; labels: string }[]
    const update = database.prepare('UPDATE tasks SET labels = ? WHERE id = ?')
    for (const row of rows) {
      const labels = (JSON.parse(row.labels) as string[]).filter((l) => l !== 'ai-locked')
      update.run(JSON.stringify(labels), row.id)
    }
    const registry = database.prepare("DELETE FROM labels WHERE name = 'ai-locked'").run().changes
    return { registry, tasks: rows.length }
  })
  return run()
}

/**
 * Seed the label registry from labels already in use (REDESIGN-V03 §7.2).
 *
 * Enforcement rejects unknown labels, so the registry MUST be populated before
 * validation turns on — otherwise every existing task fails the moment anyone
 * edits it. This runs on startup, ahead of any request.
 *
 * Sources both `tasks.labels` (the labels actually on tasks) and each user's
 * `label_config` (labels they styled but may have since removed from every
 * task) so nothing already known to the app is treated as a typo.
 *
 * Idempotent: INSERT OR IGNORE against the unique (user_id, name) index, so
 * re-running adds only genuinely new values. Labels created after this point
 * come through the API's explicit create path, not from here.
 */
function backfillLabelRegistry(database: Database.Database): void {
  const insert = database.prepare(
    'INSERT OR IGNORE INTO labels (user_id, name, facet) VALUES (?, ?, ?)',
  )

  // Operational labels carry behavior rather than domain meaning. Recording the
  // facet here keeps the chip bar's AND-across-facets grouping correct without
  // a second pass to classify them later.
  const OPERATIONAL = SYSTEM_LABELS

  const backfill = database.transaction(() => {
    // Seed the operational labels for every user regardless of current use.
    // These are system vocabulary, not user taxonomy: `ai-added` in particular
    // must already exist or the first `confirm` on a task would be rejected as
    // an unknown label by the very validation this registry adds.
    const allUsers = database.prepare('SELECT id FROM users').all() as { id: number }[]
    for (const user of allUsers) {
      for (const name of OPERATIONAL) {
        insert.run(user.id, name, 'operational')
      }
    }

    const taskRows = database.prepare('SELECT user_id, labels FROM tasks').all() as {
      user_id: number
      labels: string
    }[]
    for (const row of taskRows) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.labels || '[]')
      } catch {
        continue
      }
      if (!Array.isArray(parsed)) continue
      for (const name of parsed) {
        if (typeof name !== 'string' || name.length === 0) continue
        insert.run(row.user_id, name, OPERATIONAL.has(name) ? 'operational' : 'domain')
      }
    }

    const userRows = database.prepare('SELECT id, label_config FROM users').all() as {
      id: number
      label_config: string
    }[]
    for (const row of userRows) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.label_config || '[]')
      } catch {
        continue
      }
      if (!Array.isArray(parsed)) continue
      for (const entry of parsed) {
        const name = (entry as { name?: unknown })?.name
        if (typeof name !== 'string' || name.length === 0) continue
        insert.run(row.id, name, OPERATIONAL.has(name) ? 'operational' : 'domain')
      }
    }
  })

  backfill()
}

function initSchema(database: Database.Database): void {
  const schemaPath = path.join(__dirname, 'schema.sql')

  // In development/testing, the schema.sql might be in a different location
  let schema: string
  if (fs.existsSync(schemaPath)) {
    schema = fs.readFileSync(schemaPath, 'utf-8')
  } else {
    // Fallback: look relative to cwd for Next.js builds
    const altPath = path.join(process.cwd(), 'src', 'core', 'db', 'schema.sql')
    if (fs.existsSync(altPath)) {
      schema = fs.readFileSync(altPath, 'utf-8')
    } else {
      throw new Error(`Schema file not found at ${schemaPath} or ${altPath}`)
    }
  }

  // Execute schema (CREATE IF NOT EXISTS is idempotent)
  database.exec(schema)

  // Run migrations for existing databases
  runMigrations(database)
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

// For testing: reset database to fresh state
export function resetDb(): void {
  closeDb()
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH)
    // Also remove WAL and SHM files if they exist
    const walPath = `${DB_PATH}-wal`
    const shmPath = `${DB_PATH}-shm`
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath)
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath)
  }
}

// Utility to run a function inside a transaction
export function withTransaction<T>(fn: (db: Database.Database) => T): T {
  const database = getDb()
  return database.transaction(fn)(database)
}
