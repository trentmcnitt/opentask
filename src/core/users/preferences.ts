/**
 * User preferences: the `users` columns behind `GET`/`PATCH /api/user/preferences`.
 *
 * The route validates the request body and shapes the response (it adds the
 * AI-availability fields, which aren't stored); this module owns the SQL.
 * Preferences are not undoable, so nothing here writes the undo log.
 */

import { getDb } from '@/core/db'
import { rolloverTrackedPeriods } from '@/core/tasks/period-rollover'
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
  default_grouping: 'time',
  default_sort: 'due_date',
  default_sort_reversed: 0,
  filters_expanded: 0,
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

/**
 * Write a validated set of preference changes and return the row as stored.
 *
 * A new first day of the week moves every weekly quota's boundary. Close
 * what that ends now (it may be in the past — flipping to Monday on a
 * Wednesday ends a Sunday-anchored week at Monday), so the Quotas panel
 * shows the new week at once instead of after the next cron tick.
 */
export function updatePreferences(userId: number, changes: PreferenceChanges): PreferencesRow {
  const columns = Object.keys(changes) as PreferenceColumn[]
  for (const column of columns) {
    // Defensive: the keys become SQL identifiers.
    if (!PREFERENCE_COLUMNS.includes(column)) throw new Error(`Unknown preference: ${column}`)
  }
  if (columns.length > 0) {
    const assignments = columns.map((column) => `${column} = ?`).join(', ')
    getDb()
      .prepare(`UPDATE users SET ${assignments} WHERE id = ?`)
      .run(...columns.map((column) => changes[column]), userId)
  }

  if (changes.week_start !== undefined) rolloverTrackedPeriods(new Date(), userId)

  return readPreferencesRow(userId) as PreferencesRow
}

/** Whether `slotId` is one of the user's own time slots (reminder periods). */
export function ownsTimeSlot(userId: number, slotId: number): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM time_slots WHERE id = ? AND user_id = ?')
    .get(slotId, userId)
}
