/**
 * User preferences API
 *
 * GET  /api/user/preferences - Get user preferences
 * PATCH /api/user/preferences - Update user preferences
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, forbidden, badRequest, handleError } from '@/lib/api-response'
import { isAIEnabled } from '@/core/ai/sdk'
import { isSdkAvailableSync } from '@/core/ai/provider'
import { getFeatureInfo, isAnyApiProviderAvailable } from '@/core/ai/models'
import type { FeatureMode } from '@/core/ai/user-context'
import { LABEL_COLOR_NAMES } from '@/lib/label-colors'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import { coerceWeekStart, WEEK_STARTS, type WeekStart } from '@/lib/week-start'
import { ACCEPTED_GROUPING_INPUTS, coerceGrouping, GROUPINGS } from '@/lib/grouping'
import {
  DEFAULT_PRIORITY_DISPLAY,
  getPreferences,
  ownsTimeSlot,
  updatePreferences,
  type PreferenceChanges,
  type PreferenceColumn,
  type PreferencesRow,
} from '@/core/users/preferences'
import type { LabelConfig, LabelColor, PriorityDisplayConfig } from '@/types'

// `default_grouping` accepts the live groupings (`GROUPINGS`: slot, time, new,
// unified) plus the retired 'project', which is stored as 'time' so an old
// client's PATCH doesn't 400 (Projects left the view switch 2026-09-29; see
// `src/lib/grouping.ts`). 'reminders' was briefly valid here, back when the §6
// Reminders surface rode in the dashboard's view toggle; it and 'recent' (the
// short-lived "Recent" view, replaced by just-added previews) are refused with
// 400 — clients coerce any lingering stored value to 'slot'.
const VALID_SORT_OPTIONS = [
  'due_date',
  'priority',
  'title',
  'age',
  'modified',
  'original_due',
  'ai_insights',
] as const
const VALID_AI_MODES = ['off', 'on'] as const
const VALID_FEATURE_MODES = ['off', 'sdk', 'api'] as const

/**
 * Parse label_config and priority_display JSON columns from a preferences row,
 * returning typed values with safe fallbacks.
 */
function parsePreferencesRow(row: { label_config: string; priority_display: string }): {
  labelConfig: LabelConfig[]
  priorityDisplay: PriorityDisplayConfig
} {
  let labelConfig: LabelConfig[] = []
  try {
    labelConfig = row.label_config ? JSON.parse(row.label_config) : []
  } catch {
    labelConfig = []
  }

  let priorityDisplay: PriorityDisplayConfig = DEFAULT_PRIORITY_DISPLAY
  try {
    priorityDisplay = row.priority_display
      ? { ...DEFAULT_PRIORITY_DISPLAY, ...JSON.parse(row.priority_display) }
      : DEFAULT_PRIORITY_DISPLAY
  } catch {
    priorityDisplay = DEFAULT_PRIORITY_DISPLAY
  }

  return { labelConfig, priorityDisplay }
}

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) return unauthorized()

    return success(formatPreferencesResponse(getPreferences(user.id)))
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/user/preferences error:', err)
    return handleError(err)
  }
})

function validateLabelConfig(input: unknown): LabelConfig[] | string {
  if (!Array.isArray(input)) return 'label_config must be an array'
  if (input.length > 50) return 'label_config must have at most 50 labels'

  const seen = new Set<string>()
  const result: LabelConfig[] = []

  for (const item of input) {
    if (!item || typeof item !== 'object') return 'Each label must be an object with name and color'

    const { name, color } = item as { name?: unknown; color?: unknown }
    if (typeof name !== 'string' || !name.trim()) return 'Each label must have a non-empty name'
    if (name.trim().length > 50) return 'Label names must be at most 50 characters'
    if (typeof color !== 'string' || !LABEL_COLOR_NAMES.includes(color as LabelColor))
      return `Invalid color "${color}". Valid colors: ${LABEL_COLOR_NAMES.join(', ')}`

    const key = name.trim().toLowerCase()
    if (seen.has(key)) return `Duplicate label name: "${name.trim()}"`
    seen.add(key)

    result.push({ name: name.trim(), color: color as LabelColor })
  }

  return result
}

const VALID_BADGE_STYLES = ['words', 'icons'] as const

function validatePriorityDisplay(input: unknown): PriorityDisplayConfig | string {
  if (!input || typeof input !== 'object') {
    return 'priority_display must be an object'
  }
  const obj = input as Record<string, unknown>
  if (typeof obj.trailingDot !== 'boolean') {
    return 'priority_display.trailingDot must be a boolean'
  }
  if (
    obj.badgeStyle !== undefined &&
    !VALID_BADGE_STYLES.includes(obj.badgeStyle as (typeof VALID_BADGE_STYLES)[number])
  ) {
    return 'priority_display.badgeStyle must be "words" or "icons"'
  }
  if (typeof obj.colorTitle !== 'boolean') {
    return 'priority_display.colorTitle must be a boolean'
  }
  if (typeof obj.rightBorder !== 'boolean') {
    return 'priority_display.rightBorder must be a boolean'
  }
  if (obj.colorCheckbox !== undefined && typeof obj.colorCheckbox !== 'boolean') {
    return 'priority_display.colorCheckbox must be a boolean'
  }
  return {
    trailingDot: obj.trailingDot,
    badgeStyle: (obj.badgeStyle as 'words' | 'icons') || 'words',
    colorTitle: obj.colorTitle,
    rightBorder: obj.rightBorder,
    colorCheckbox: typeof obj.colorCheckbox === 'boolean' ? obj.colorCheckbox : true,
  }
}

/** The error for a value that isn't an integer in [min, max], or null if it is. */
function intInRange(val: unknown, field: string, min: number, max: number): string | null {
  if (typeof val !== 'number' || !Number.isInteger(val) || val < min || val > max)
    return `${field} must be an integer between ${min} and ${max}`
  return null
}

/** The error for a value that isn't a valid "HH:MM" time of day, or null if it is. */
function hhmm(val: unknown, field: string): string | null {
  if (typeof val !== 'string' || !/^\d{2}:\d{2}$/.test(val))
    return `${field} must be in HH:MM format`
  const [hours, minutes] = val.split(':').map(Number)
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59)
    return `${field} must have valid hours (0-23) and minutes (0-59)`
  return null
}

/** Validate general preference fields (grouping, labels, priority display, snooze, time). */
function validateGeneralFields(
  body: Record<string, unknown>,
  changes: PreferenceChanges,
): string | null {
  if (body.default_grouping !== undefined) {
    if (!ACCEPTED_GROUPING_INPUTS.includes(body.default_grouping as string))
      return `default_grouping must be one of: ${GROUPINGS.join(', ')}`
    changes.default_grouping = coerceGrouping(body.default_grouping)
  }

  if (body.default_sort !== undefined) {
    if (!VALID_SORT_OPTIONS.includes(body.default_sort as (typeof VALID_SORT_OPTIONS)[number]))
      return 'default_sort must be one of: ' + VALID_SORT_OPTIONS.join(', ')
    changes.default_sort = body.default_sort
  }

  if (body.default_sort_reversed !== undefined) {
    if (typeof body.default_sort_reversed !== 'boolean')
      return 'default_sort_reversed must be a boolean'
    changes.default_sort_reversed = body.default_sort_reversed ? 1 : 0
  }

  // §7.3: whether the dashboard's filter-chip section is pinned open.
  if (body.filters_expanded !== undefined) {
    if (typeof body.filters_expanded !== 'boolean') return 'filters_expanded must be a boolean'
    changes.filters_expanded = body.filters_expanded ? 1 : 0
  }

  // §5: whether the Track panel is pinned open.
  if (body.track_expanded !== undefined) {
    if (typeof body.track_expanded !== 'boolean') return 'track_expanded must be a boolean'
    changes.track_expanded = body.track_expanded ? 1 : 0
  }

  // §5: whether /quotas opens on the detailed list rather than the summary.
  if (body.quotas_details !== undefined) {
    if (typeof body.quotas_details !== 'boolean') return 'quotas_details must be a boolean'
    changes.quotas_details = body.quotas_details ? 1 : 0
  }

  if (body.label_config !== undefined) {
    const validated = validateLabelConfig(body.label_config)
    if (typeof validated === 'string') return validated
    changes.label_config = JSON.stringify(validated)
  }

  if (body.priority_display !== undefined) {
    const validated = validatePriorityDisplay(body.priority_display)
    if (typeof validated === 'string') return validated
    changes.priority_display = JSON.stringify(validated)
  }

  if (body.auto_snooze_minutes !== undefined) {
    const err = intInRange(body.auto_snooze_minutes, 'auto_snooze_minutes', 1, 360)
    if (err) return err
    changes.auto_snooze_minutes = body.auto_snooze_minutes
  }

  if (body.auto_snooze_urgent_minutes !== undefined) {
    const err = intInRange(body.auto_snooze_urgent_minutes, 'auto_snooze_urgent_minutes', 1, 360)
    if (err) return err
    changes.auto_snooze_urgent_minutes = body.auto_snooze_urgent_minutes
  }

  // §4.1 cadence ladder
  if (body.auto_snooze_low_minutes !== undefined) {
    // Ceiling is 1440 (24h), not 360 like the upper tiers: P1 is deliberately
    // rare, so "a few times a day" must be expressible.
    const err = intInRange(body.auto_snooze_low_minutes, 'auto_snooze_low_minutes', 1, 1440)
    if (err) return err
    changes.auto_snooze_low_minutes = body.auto_snooze_low_minutes
  }

  if (body.auto_snooze_medium_minutes !== undefined) {
    const err = intInRange(body.auto_snooze_medium_minutes, 'auto_snooze_medium_minutes', 1, 1440)
    if (err) return err
    changes.auto_snooze_medium_minutes = body.auto_snooze_medium_minutes
  }

  if (body.auto_snooze_high_minutes !== undefined) {
    const err = intInRange(body.auto_snooze_high_minutes, 'auto_snooze_high_minutes', 1, 360)
    if (err) return err
    changes.auto_snooze_high_minutes = body.auto_snooze_high_minutes
  }

  if (body.notifications_enabled !== undefined) {
    if (typeof body.notifications_enabled !== 'boolean')
      return 'notifications_enabled must be a boolean'
    changes.notifications_enabled = body.notifications_enabled ? 1 : 0
  }

  // The "AI finished" push for a just-added task (enrichment-notify.ts).
  if (body.enrichment_notifications_enabled !== undefined) {
    if (typeof body.enrichment_notifications_enabled !== 'boolean')
      return 'enrichment_notifications_enabled must be a boolean'
    changes.enrichment_notifications_enabled = body.enrichment_notifications_enabled ? 1 : 0
  }

  if (body.critical_alert_volume !== undefined) {
    const val = body.critical_alert_volume
    if (typeof val !== 'number' || val < 0 || val > 1)
      return 'critical_alert_volume must be a number between 0.0 and 1.0'
    changes.critical_alert_volume = val
  }

  if (body.default_snooze_option !== undefined) {
    const val = body.default_snooze_option
    if (typeof val !== 'string') return 'default_snooze_option must be a string'
    if (val !== 'tomorrow') {
      const num = parseInt(val, 10)
      if (isNaN(num) || num < 1 || num > 1440 || String(num) !== val)
        return 'default_snooze_option must be "tomorrow" or a string integer 1-1440'
    }
    changes.default_snooze_option = val
  }

  if (body.bulk_snooze_default !== undefined) {
    const val = body.bulk_snooze_default
    if (val !== 'next_period' && val !== 'default_option')
      return 'bulk_snooze_default must be "next_period" or "default_option"'
    changes.bulk_snooze_default = val
  }

  if (body.morning_time !== undefined) {
    const err = hhmm(body.morning_time, 'morning_time')
    if (err) return err
    changes.morning_time = body.morning_time
  }

  if (body.wake_time !== undefined) {
    const err = hhmm(body.wake_time, 'wake_time')
    if (err) return err
    changes.wake_time = body.wake_time
  }

  if (body.sleep_time !== undefined) {
    const err = hhmm(body.sleep_time, 'sleep_time')
    if (err) return err
    changes.sleep_time = body.sleep_time
  }

  return null
}

/** Validate a per-feature AI mode field. */
function validateFeatureMode(
  body: Record<string, unknown>,
  field: PreferenceColumn,
  changes: PreferenceChanges,
): string | null {
  if (body[field] === undefined) return null
  if (!VALID_FEATURE_MODES.includes(body[field] as (typeof VALID_FEATURE_MODES)[number]))
    return `${field} must be "off", "sdk", or "api"`
  // Allow saving any valid mode even if the provider isn't available yet.
  // The UI shows an amber warning for unavailable modes, and the feature info
  // popover explains what's missing. This lets users pre-configure modes before
  // the admin sets up the provider.
  changes[field] = body[field]
  return null
}

/** Validate AI-related preference fields (context, mode, show scores/signals, per-feature modes). */
function validateAiFields(
  body: Record<string, unknown>,
  changes: PreferenceChanges,
): string | null {
  if (body.ai_context !== undefined) {
    const val = body.ai_context
    if (val !== null && typeof val !== 'string') return 'ai_context must be a string or null'
    let resolved: string | null = null
    if (typeof val === 'string') {
      const trimmed = val.trim()
      if (trimmed.length > 1000) return 'ai_context must be at most 1000 characters'
      resolved = trimmed.length > 0 ? trimmed : null
    }
    changes.ai_context = resolved
  }

  if (body.ai_mode !== undefined) {
    if (!VALID_AI_MODES.includes(body.ai_mode as (typeof VALID_AI_MODES)[number]))
      return 'ai_mode must be "off" or "on"'
    changes.ai_mode = body.ai_mode
  }

  if (body.ai_show_scores !== undefined) {
    if (typeof body.ai_show_scores !== 'boolean') return 'ai_show_scores must be a boolean'
    changes.ai_show_scores = body.ai_show_scores ? 1 : 0
  }

  if (body.ai_show_signals !== undefined) {
    if (typeof body.ai_show_signals !== 'boolean') return 'ai_show_signals must be a boolean'
    changes.ai_show_signals = body.ai_show_signals ? 1 : 0
  }

  // Per-feature AI mode fields
  const featureModeFields: PreferenceColumn[] = [
    'ai_enrichment_mode',
    'ai_quicktake_mode',
    'ai_whats_next_mode',
    'ai_insights_mode',
  ]
  for (const field of featureModeFields) {
    const err = validateFeatureMode(body, field, changes)
    if (err) return err
  }

  if (body.ai_wn_commentary_unfiltered !== undefined) {
    if (typeof body.ai_wn_commentary_unfiltered !== 'boolean')
      return 'ai_wn_commentary_unfiltered must be a boolean'
    changes.ai_wn_commentary_unfiltered = body.ai_wn_commentary_unfiltered ? 1 : 0
  }

  if (body.ai_wn_highlight !== undefined) {
    if (typeof body.ai_wn_highlight !== 'boolean') return 'ai_wn_highlight must be a boolean'
    changes.ai_wn_highlight = body.ai_wn_highlight ? 1 : 0
  }

  if (body.ai_insights_signal_chips !== undefined) {
    if (typeof body.ai_insights_signal_chips !== 'boolean')
      return 'ai_insights_signal_chips must be a boolean'
    changes.ai_insights_signal_chips = body.ai_insights_signal_chips ? 1 : 0
  }

  if (body.ai_insights_score_chips !== undefined) {
    if (typeof body.ai_insights_score_chips !== 'boolean')
      return 'ai_insights_score_chips must be a boolean'
    changes.ai_insights_score_chips = body.ai_insights_score_chips ? 1 : 0
  }

  // Per-feature AI query timeouts
  const timeoutFields = [
    { field: 'ai_enrichment_timeout_ms', min: 10000, max: 300000 },
    { field: 'ai_quicktake_timeout_ms', min: 10000, max: 120000 },
    { field: 'ai_whats_next_timeout_ms', min: 10000, max: 600000 },
    { field: 'ai_insights_timeout_ms', min: 60000, max: 1800000 },
  ] as const
  for (const { field, min, max } of timeoutFields) {
    if (body[field] !== undefined) {
      const val = body[field]
      if (val !== null) {
        if (typeof val !== 'number' || !Number.isInteger(val) || val < min || val > max)
          return `${field} must be null or an integer between ${min} and ${max}`
      }
      changes[field] = val
    }
  }

  return null
}

/**
 * The DEFAULT REMINDER SLOT and the quota-reminders switch.
 *
 * `quota_prompt_slot_id` began (2026-09-24) as the period unmet quotas prompt
 * in by default; since 2026-09-28 it is the default slot for ALL reminders —
 * where a reminder with no stated time goes (`defaultReminderSlot`). The
 * field keeps its name for existing clients, and `default_reminder_slot_id`
 * is an alias for it, read and written alike (sending both with different
 * values is refused). The slot must be one of the user's own; `null` means
 * "the first period of the day". A slot deleted later is not chased down here
 * — readers resolve the id and fall back (`resolvePromptSlot`), and undoing the
 * delete brings the slot back under the same id.
 */
function validateQuotaPromptFields(
  body: Record<string, unknown>,
  userId: number,
  changes: PreferenceChanges,
): string | null {
  const alias = body.default_reminder_slot_id
  if (
    alias !== undefined &&
    body.quota_prompt_slot_id !== undefined &&
    alias !== body.quota_prompt_slot_id
  )
    return 'default_reminder_slot_id and quota_prompt_slot_id are the same setting — send one'
  const slotField = alias !== undefined ? 'default_reminder_slot_id' : 'quota_prompt_slot_id'
  if (body[slotField] !== undefined) {
    const val = body[slotField]
    if (val !== null) {
      if (typeof val !== 'number' || !Number.isInteger(val) || val <= 0)
        return `${slotField} must be a time slot id or null`
      if (!ownsTimeSlot(userId, val)) return `${slotField} must be one of your reminder periods`
    }
    changes.quota_prompt_slot_id = val
  }
  if (body.quota_prompts_enabled !== undefined) {
    if (typeof body.quota_prompts_enabled !== 'boolean')
      return 'quota_prompts_enabled must be a boolean'
    changes.quota_prompts_enabled = body.quota_prompts_enabled ? 1 : 0
  }
  // Where weekly quota periods start and end (src/lib/week-start.ts).
  if (body.week_start !== undefined) {
    if (!WEEK_STARTS.includes(body.week_start as WeekStart))
      return `week_start must be one of: ${WEEK_STARTS.join(', ')}`
    changes.week_start = body.week_start
  }
  return null
}

/**
 * Validate all PATCH fields and build the column → value changes to store.
 * Returns a string error message on validation failure, or the validated result.
 */
function validatePatchFields(
  body: Record<string, unknown>,
  userId: number,
): PreferenceChanges | string {
  const changes: PreferenceChanges = {}

  const generalErr = validateGeneralFields(body, changes)
  if (generalErr) return generalErr

  const quotaErr = validateQuotaPromptFields(body, userId, changes)
  if (quotaErr) return quotaErr

  const aiErr = validateAiFields(body, changes)
  if (aiErr) return aiErr

  if (Object.keys(changes).length === 0) return 'No preferences to update'

  return changes
}

function formatPreferencesResponse(row: PreferencesRow) {
  const { labelConfig, priorityDisplay } = parsePreferencesRow(row)
  return {
    ai_available: isAIEnabled(),
    // Coerced on the way out too, so a 'project' written by anything that
    // skipped this route reads as the 'time' the dashboard will show.
    default_grouping: coerceGrouping(row.default_grouping),
    default_sort: row.default_sort,
    default_sort_reversed: row.default_sort_reversed !== 0,
    filters_expanded: row.filters_expanded !== 0,
    track_expanded: row.track_expanded !== 0,
    quotas_details: row.quotas_details !== 0,
    label_config: labelConfig,
    priority_display: priorityDisplay,
    auto_snooze_minutes: row.auto_snooze_minutes,
    auto_snooze_urgent_minutes: row.auto_snooze_urgent_minutes,
    auto_snooze_high_minutes: row.auto_snooze_high_minutes,
    default_snooze_option: row.default_snooze_option,
    bulk_snooze_default: row.bulk_snooze_default,
    week_start: coerceWeekStart(row.week_start),
    quota_prompt_slot_id: row.quota_prompt_slot_id,
    // Alias: the same column, under the name it has meant since 2026-09-28.
    default_reminder_slot_id: row.quota_prompt_slot_id,
    quota_prompts_enabled: row.quota_prompts_enabled !== 0,
    morning_time: row.morning_time,
    wake_time: row.wake_time,
    sleep_time: row.sleep_time,
    notifications_enabled: row.notifications_enabled !== 0,
    enrichment_notifications_enabled: row.enrichment_notifications_enabled !== 0,
    critical_alert_volume: row.critical_alert_volume,
    ai_context: row.ai_context,
    ai_mode: row.ai_mode,
    ai_show_scores: row.ai_show_scores !== 0,
    ai_show_signals: row.ai_show_signals !== 0,
    ai_enrichment_mode: row.ai_enrichment_mode as FeatureMode,
    ai_quicktake_mode: row.ai_quicktake_mode as FeatureMode,
    ai_whats_next_mode: row.ai_whats_next_mode as FeatureMode,
    ai_insights_mode: row.ai_insights_mode as FeatureMode,
    ai_wn_commentary_unfiltered: row.ai_wn_commentary_unfiltered !== 0,
    ai_wn_highlight: row.ai_wn_highlight !== 0,
    ai_insights_signal_chips: row.ai_insights_signal_chips !== 0,
    ai_insights_score_chips: row.ai_insights_score_chips !== 0,
    ai_enrichment_timeout_ms: row.ai_enrichment_timeout_ms,
    ai_quicktake_timeout_ms: row.ai_quicktake_timeout_ms,
    ai_whats_next_timeout_ms: row.ai_whats_next_timeout_ms,
    ai_insights_timeout_ms: row.ai_insights_timeout_ms,
    ai_sdk_available: isSdkAvailableSync(),
    ai_api_available: isAnyApiProviderAvailable(),
    ai_feature_info: {
      enrichment: getFeatureInfo('enrichment', row.ai_enrichment_mode as FeatureMode),
      quick_take: getFeatureInfo('quick_take', row.ai_quicktake_mode as FeatureMode),
      whats_next: getFeatureInfo('whats_next', row.ai_whats_next_mode as FeatureMode),
      insights: getFeatureInfo('insights', row.ai_insights_mode as FeatureMode),
    },
  }
}

// AI fields that demo users cannot modify
const DEMO_PROTECTED_FIELDS = [
  'ai_context',
  'ai_mode',
  'ai_enrichment_mode',
  'ai_quicktake_mode',
  'ai_whats_next_mode',
  'ai_insights_mode',
  'ai_enrichment_timeout_ms',
  'ai_quicktake_timeout_ms',
  'ai_whats_next_timeout_ms',
  'ai_insights_timeout_ms',
]

export const PATCH = withLogging(async function PATCH(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) return unauthorized()

    const body = await request.json()

    if (user.is_demo && DEMO_PROTECTED_FIELDS.some((f) => body[f] !== undefined)) {
      return forbidden('This setting is not available in demo mode')
    }

    const result = validatePatchFields(body, user.id)
    if (typeof result === 'string') return badRequest(result)

    // Also closes weekly quota periods a new `week_start` ends (see updatePreferences).
    return success(formatPreferencesResponse(updatePreferences(user.id, result)))
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'PATCH /api/user/preferences error:', err)
    return handleError(err)
  }
})
