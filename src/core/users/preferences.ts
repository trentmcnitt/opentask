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
  quota_prompt_slot_id: number | null
  quota_prompts_enabled: number
  morning_time: string
  wake_time: string
  sleep_time: string
  notifications_enabled: number
  enrichment_notifications_enabled: number
  sweep_feedback_notifications_enabled: number
  critical_alert_volume: number
  ai_context: string | null
  ai_mode: string
  ai_show_scores: number
  ai_show_signals: number
  ai_enrichment_mode: string
  ai_quicktake_mode: string
  ai_whats_next_mode: string
  ai_insights_mode: string
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
  default_sort: 'due_date',
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
  quota_prompt_slot_id: null,
  quota_prompts_enabled: 1,
  morning_time: '09:00',
  wake_time: '07:00',
  sleep_time: '22:00',
  notifications_enabled: 1,
  enrichment_notifications_enabled: 1,
  sweep_feedback_notifications_enabled: 1,
  critical_alert_volume: 1.0,
  ai_context: null,
  ai_mode: 'on',
  ai_show_scores: 1,
  ai_show_signals: 1,
  ai_enrichment_mode: 'api',
  ai_quicktake_mode: 'api',
  ai_whats_next_mode: 'api',
  ai_insights_mode: 'api',
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
 * A new first day of the week moves every weekly quota's boundary. Close
 * what that ends now (it may be in the past — flipping to Monday on a
 * Wednesday ends a Sunday-anchored week at Monday), so the Quotas panel
 * shows the new week at once instead of after the next cron tick.
 *
 * Afterwards it emits a sync event so other open tabs pick the change up.
 * Only a label change can show on a widget (the Quotas widget and the watch
 * colour labels from `label_config`), so only that one spends a widget push.
 */
export function updatePreferences(userId: number, changes: PreferenceChanges): PreferencesRow {
  const columns = Object.keys(changes) as PreferenceColumn[]
  for (const column of columns) {
    // Defensive: the keys become SQL identifiers.
    if (!PREFERENCE_COLUMNS.includes(column)) throw new Error(`Unknown preference: ${column}`)
  }
  const labelConfigChanged = typeof changes.label_config === 'string'
  if (columns.length > 0) {
    const assignments = columns.map((column) => `${column} = ?`).join(', ')
    withTransaction((db) => {
      const oldLabelConfig = labelConfigChanged
        ? readPreferencesRow(userId)?.label_config
        : undefined
      db.prepare(`UPDATE users SET ${assignments} WHERE id = ?`).run(
        ...columns.map((column) => changes[column]),
        userId,
      )
      if (labelConfigChanged) {
        syncLabelRegistry(userId, oldLabelConfig, changes.label_config as string)
      }
    })
  }

  if (changes.week_start !== undefined) rolloverTrackedPeriods(new Date(), userId)

  if (columns.length > 0) emitSyncEvent(userId, { widgets: labelConfigChanged })

  return readPreferencesRow(userId) as PreferencesRow
}

/** Whether `slotId` is one of the user's own time slots (reminder periods). */
export function ownsTimeSlot(userId: number, slotId: number): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM time_slots WHERE id = ? AND user_id = ?')
    .get(slotId, userId)
}
