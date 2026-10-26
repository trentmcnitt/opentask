/**
 * User preferences: the `users` columns behind `GET`/`PATCH /api/user/preferences`.
 *
 * The route validates the request body and shapes the response (it adds the
 * AI-availability fields, which aren't stored); this module owns the SQL and
 * the side effects of a write (label registry, quota rollover, sync event).
 * Preferences are not undoable, so nothing here writes the undo log.
 */

import { getDb, withTransaction } from '@/core/db'
import { createLabel, deleteLabel, SYSTEM_LABELS, isReservedLabel } from '@/core/labels'
import { rolloverTrackedPeriods } from '@/core/tasks/period-rollover'
import { emitSyncEvent } from '@/lib/sync-events'
import { dismissEndedPromptPushes, promptPushEndCheck } from '@/core/notifications/prompt-nags'
import { nowUtc } from '@/core/recurrence'
import type { PriorityDisplayConfig } from '@/types'

export const DEFAULT_PRIORITY_DISPLAY: PriorityDisplayConfig = {
  trailingDot: true,
  badgeStyle: 'words',
  colorTitle: false,
  rightBorder: false,
  colorCheckbox: true,
}

/** The preference columns of `users`, as stored (JSON columns still serialized). */
export interface PreferencesRow {
  default_grouping: string
  default_sort: string
  default_sort_reversed: number
  filters_expanded: number
  project_preview_count: number
  track_expanded: number
  quotas_details: number
  label_config: string
  priority_display: string
  auto_snooze_minutes: number
  auto_snooze_urgent_minutes: number
  auto_snooze_high_minutes: number
  auto_snooze_low_minutes: number
  auto_snooze_medium_minutes: number
  default_snooze_option: string
  bulk_snooze_default: 'next_period' | 'default_option'
  week_start: string
  /** The horizon segments' weekday, 1 = Monday … 7 = Sunday (2026-10-12). */
  check_in_day: number
  quota_prompt_slot_id: number | null
  quota_prompts_enabled: number
  morning_time: string
  wake_time: string
  sleep_time: string
  /** Anchor-time links (`src/lib/anchor-times.ts`): a time_slots id, or null for custom. */
  morning_slot_id: number | null
  wake_slot_id: number | null
  sleep_slot_id: number | null
  /** The number pad's four buttons as stored JSON, or null for the defaults. */
  pad_presets: string | null
  /**
   * "Day starts at" (2026-10-23, `src/lib/anchor-times.ts`): a custom time
   * (slot id null), a link to a period (time = its start as of the link), or
   * both null — the default, the first period's start.
   */
  day_start_time: string | null
  day_start_slot_id: number | null
  notifications_enabled: number
  enrichment_notifications_enabled: number
  sweep_feedback_notifications_enabled: number
  critical_alert_volume: number
  ai_context: string | null
  /**
   * When `ai_context` last changed (2026-10-10). Server-stamped by
   * `updatePreferences`, never written by a client: Settings › AI shows its
   * age and staleness (`src/lib/ai-context-staleness.ts`).
   */
  ai_context_updated_at: string | null
  ai_mode: string
  ai_show_scores: number
  ai_show_signals: number
  ai_enrichment_mode: string
  ai_quicktake_mode: string
  ai_whats_next_mode: string
  ai_insights_mode: string
  ai_process_mode: string
  ai_wn_commentary_unfiltered: number
  ai_wn_highlight: number
  ai_insights_signal_chips: number
  ai_insights_score_chips: number
  ai_enrichment_timeout_ms: number | null
  ai_quicktake_timeout_ms: number | null
  ai_whats_next_timeout_ms: number | null
  ai_insights_timeout_ms: number | null
}

export type PreferenceColumn = keyof PreferencesRow

/**
 * Validated column → value pairs for one PATCH, already in their stored form
 * (booleans as 0/1, JSON columns serialized). Only the route's validators
 * build this, so the keys are always real column names.
 */
export type PreferenceChanges = Partial<Record<PreferenceColumn, unknown>>

/** Fallback row when user record is missing (should not happen in practice). */
const DEFAULT_PREFERENCES_ROW: PreferencesRow = {
  default_grouping: 'project',
  default_sort: 'horizon',
  default_sort_reversed: 0,
  filters_expanded: 0,
  project_preview_count: 6,
  track_expanded: 0,
  quotas_details: 0,
  label_config: '[]',
  priority_display: JSON.stringify(DEFAULT_PRIORITY_DISPLAY),
  auto_snooze_minutes: 30,
  auto_snooze_urgent_minutes: 5,
  auto_snooze_high_minutes: 15,
  auto_snooze_low_minutes: 240,
  auto_snooze_medium_minutes: 60,
  default_snooze_option: '60',
  bulk_snooze_default: 'next_period',
  week_start: 'sunday',
  check_in_day: 6,
  quota_prompt_slot_id: null,
  quota_prompts_enabled: 1,
  morning_time: '09:00',
  wake_time: '07:00',
  sleep_time: '22:00',
  morning_slot_id: null,
  wake_slot_id: null,
  sleep_slot_id: null,
  pad_presets: null,
  day_start_time: null,
  day_start_slot_id: null,
  notifications_enabled: 1,
  enrichment_notifications_enabled: 1,
  sweep_feedback_notifications_enabled: 1,
  critical_alert_volume: 1.0,
  ai_context: null,
  ai_context_updated_at: null,
  ai_mode: 'on',
  ai_show_scores: 1,
  ai_show_signals: 1,
  ai_enrichment_mode: 'api',
  ai_quicktake_mode: 'api',
  ai_whats_next_mode: 'api',
  ai_insights_mode: 'api',
  ai_process_mode: 'api',
  ai_wn_commentary_unfiltered: 0,
  ai_wn_highlight: 1,
  ai_insights_signal_chips: 1,
  ai_insights_score_chips: 1,
  ai_enrichment_timeout_ms: null,
  ai_quicktake_timeout_ms: null,
  ai_whats_next_timeout_ms: null,
  ai_insights_timeout_ms: null,
}

const PREFERENCE_COLUMNS = Object.keys(DEFAULT_PREFERENCES_ROW) as PreferenceColumn[]

const PREFERENCES_SELECT = `SELECT ${PREFERENCE_COLUMNS.join(', ')} FROM users WHERE id = ?`

function readPreferencesRow(userId: number): PreferencesRow | undefined {
  return getDb().prepare(PREFERENCES_SELECT).get(userId) as PreferencesRow | undefined
}

/** The user's stored preferences, or the defaults if the user row is missing. */
export function getPreferences(userId: number): PreferencesRow {
  return readPreferencesRow(userId) ?? DEFAULT_PREFERENCES_ROW
}

/** The names in a stored `label_config` JSON string (empty if it doesn't parse). */
function labelConfigNames(json: string | null | undefined): string[] {
  try {
    const parsed = json ? JSON.parse(json) : []
    return Array.isArray(parsed)
      ? parsed.map((l: { name?: unknown }) => l?.name).filter((n) => typeof n === 'string')
      : []
  } catch {
    return []
  }
}

/**
 * Keep the label registry (`src/core/labels/`) in step with Settings → Labels.
 *
 * `label_config` is the list Settings edits, but a task's labels are checked
 * against the registry, so a label added in Settings used to be rejected the
 * first time it was put on a task. Now every name in the new list is
 * registered (`createLabel` is idempotent), and a name the new list drops is
 * deregistered (decision D6, 2026-09-29: deleting a label in Settings removes
 * it for good). Deregistering doesn't strip it from tasks that carry it — see
 * `DELETE /api/labels/:name`. System and reserved (`ai-*`) names are neither
 * registered nor deregistered here: they aren't the user's to add or remove
 * (colouring one in Settings is fine; it stays whatever the registry says).
 */
function syncLabelRegistry(userId: number, oldJson: string | undefined, newJson: string): void {
  const isUsers = (name: string) => !SYSTEM_LABELS.has(name) && !isReservedLabel(name)
  const next = labelConfigNames(newJson)
  const kept = new Set(next)
  for (const name of next) if (isUsers(name)) createLabel(userId, name)
  for (const name of labelConfigNames(oldJson)) {
    if (!kept.has(name) && isUsers(name)) deleteLabel(userId, name)
  }
}

/**
 * Write a validated set of preference changes and return the row as stored.
 *
 * A new `label_config` also updates the label registry (`syncLabelRegistry`).
 *
 * A new first day of the week moves every weekly quota's boundary (a new
 * "Day starts at", every daily one's). Close what that ends now (it may be in the past — flipping to Monday on a
 * Wednesday ends a Sunday-anchored week at Monday), so the Quotas panel
 * shows the new week at once instead of after the next cron tick.
 *
 * Afterwards it emits a sync event so other open tabs pick the change up.
 * Only a label change can show on a widget (the Quotas widget and the watch
 * colour labels from `label_config`), so only that one spends a widget push.
 */
/** Preferences whose change can end a named quota-prompt push. */
const PROMPT_PUSH_PREFERENCES = new Set<string>([
  'quota_prompts_enabled',
  'quota_prompt_slot_id',
  'day_start_time',
  'day_start_slot_id',
])

export function updatePreferences(userId: number, changes: PreferenceChanges): PreferencesRow {
  const columns = Object.keys(changes) as PreferenceColumn[]
  for (const column of columns) {
    // Defensive: the keys become SQL identifiers.
    if (!PREFERENCE_COLUMNS.includes(column)) throw new Error(`Unknown preference: ${column}`)
  }
  const labelConfigChanged = typeof changes.label_config === 'string'
  const aiContextSent = changes.ai_context !== undefined
  // A change that can end a named quota-prompt push (prompt-nags.ts): the
  // prompt switch, the default prompt period, the day start. Its delivered
  // banners go (review of #377). Cheap: nothing is computed unless a prompt
  // was pushed today.
  const endedPromptPushes = columns.some((c) => PROMPT_PUSH_PREFERENCES.has(c))
    ? promptPushEndCheck(userId, 'all')
    : () => []
  if (columns.length > 0) {
    withTransaction((db) => {
      const old = labelConfigChanged || aiContextSent ? readPreferencesRow(userId) : undefined
      // THE AI CONTEXT'S AGE (2026-10-10): stamped here, so every writer of
      // `ai_context` keeps it, and only when the text actually changes —
      // Trent asked for a warning when the context "hasn't been updated", so
      // re-saving the same words leaves the clock alone. Clearing it (null)
      // is a change and stamps.
      const stamp: Partial<Record<PreferenceColumn, unknown>> =
        aiContextSent && old && (old.ai_context ?? null) !== (changes.ai_context ?? null)
          ? { ai_context_updated_at: nowUtc() }
          : {}
      const all = { ...changes, ...stamp }
      const cols = Object.keys(all) as PreferenceColumn[]
      db.prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
        ...cols.map((column) => all[column]),
        userId,
      )
      const oldLabelConfig = old?.label_config
      if (labelConfigChanged) {
        syncLabelRegistry(userId, oldLabelConfig, changes.label_config as string)
      }
    })
  }

  // A new day start ("Day starts at", 2026-10-23) moves every daily quota's
  // boundary the same way, and what today's reminders are.
  const dayStartChanged =
    changes.day_start_time !== undefined || changes.day_start_slot_id !== undefined

  // Its activity rows are `system` (the rollover runs as the system itself).
  if (changes.week_start !== undefined || dayStartChanged) {
    rolloverTrackedPeriods(new Date(), userId)
  }

  // The Reminders widget and the watch draw the server's roster for the day,
  // which a new day start can change: that one spends a widget push too.
  if (columns.length > 0) {
    emitSyncEvent(userId, { widgets: labelConfigChanged || dayStartChanged })
  }
  dismissEndedPromptPushes(userId, endedPromptPushes)

  return readPreferencesRow(userId) as PreferencesRow
}

/** `slotId` if it is one of the user's own time slots (reminder periods), else null. */
export function ownedTimeSlot(
  userId: number,
  slotId: number,
): { id: number; start_time: string } | null {
  return (
    (getDb()
      .prepare('SELECT id, start_time FROM time_slots WHERE id = ? AND user_id = ?')
      .get(slotId, userId) as { id: number; start_time: string } | undefined) ?? null
  )
}
