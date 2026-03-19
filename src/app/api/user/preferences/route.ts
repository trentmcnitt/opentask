/**
 * User preferences API
 *
 * GET  /api/user/preferences - Get user preferences
 * PATCH /api/user/preferences - Update user preferences
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, forbidden, badRequest, handleError } from '@/lib/api-response'
import { getDb } from '@/core/db'
import { isAIEnabled } from '@/core/ai/sdk'
import { isSdkAvailableSync } from '@/core/ai/provider'
import { getFeatureInfo, isAnyApiProviderAvailable } from '@/core/ai/models'
import type { FeatureMode } from '@/core/ai/user-context'
import { LABEL_COLOR_NAMES } from '@/lib/label-colors'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'
import type { LabelConfig, LabelColor, PriorityDisplayConfig } from '@/types'

const VALID_GROUPINGS = ['time', 'project', 'unified'] as const
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
const DEFAULT_PRIORITY_DISPLAY: PriorityDisplayConfig = {
  trailingDot: true,
  badgeStyle: 'words',
  colorTitle: false,
  rightBorder: false,
  colorCheckbox: true,
}

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

    const db = getDb()
    const row = db.prepare(PREFERENCES_SELECT).get(user.id) as PreferencesRow | undefined
    if (!row) return success(formatPreferencesResponse(DEFAULT_PREFERENCES_ROW))

    return success(formatPreferencesResponse(row))
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

type ValidatedPatch = { updates: string[]; params: unknown[] }

/** Validate general preference fields (grouping, labels, priority display, snooze, time). */
function validateGeneralFields(
  body: Record<string, unknown>,
  updates: string[],
  params: unknown[],
): string | null {
  if (body.default_grouping !== undefined) {
    if (!VALID_GROUPINGS.includes(body.default_grouping as (typeof VALID_GROUPINGS)[number]))
      return 'default_grouping must be "time", "project", or "unified"'
    updates.push('default_grouping = ?')
    params.push(body.default_grouping)
  }

  if (body.default_sort !== undefined) {
    if (!VALID_SORT_OPTIONS.includes(body.default_sort as (typeof VALID_SORT_OPTIONS)[number]))
      return 'default_sort must be one of: ' + VALID_SORT_OPTIONS.join(', ')
    updates.push('default_sort = ?')
    params.push(body.default_sort)
  }

  if (body.default_sort_reversed !== undefined) {
    if (typeof body.default_sort_reversed !== 'boolean')
      return 'default_sort_reversed must be a boolean'
    updates.push('default_sort_reversed = ?')
    params.push(body.default_sort_reversed ? 1 : 0)
  }

  if (body.label_config !== undefined) {
    const validated = validateLabelConfig(body.label_config)
    if (typeof validated === 'string') return validated
    updates.push('label_config = ?')
    params.push(JSON.stringify(validated))
  }

  if (body.priority_display !== undefined) {
    const validated = validatePriorityDisplay(body.priority_display)
    if (typeof validated === 'string') return validated
    updates.push('priority_display = ?')
    params.push(JSON.stringify(validated))
  }

  if (body.auto_snooze_minutes !== undefined) {
    const val = body.auto_snooze_minutes
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 1 || val > 360)
      return 'auto_snooze_minutes must be an integer between 1 and 360'
    updates.push('auto_snooze_minutes = ?')
    params.push(val)
  }

  if (body.auto_snooze_urgent_minutes !== undefined) {
    const val = body.auto_snooze_urgent_minutes
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 1 || val > 360)
      return 'auto_snooze_urgent_minutes must be an integer between 1 and 360'
    updates.push('auto_snooze_urgent_minutes = ?')
    params.push(val)
  }

  if (body.auto_snooze_high_minutes !== undefined) {
    const val = body.auto_snooze_high_minutes
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 1 || val > 360)
      return 'auto_snooze_high_minutes must be an integer between 1 and 360'
    updates.push('auto_snooze_high_minutes = ?')
    params.push(val)
  }

  if (body.notifications_enabled !== undefined) {
    if (typeof body.notifications_enabled !== 'boolean')
      return 'notifications_enabled must be a boolean'
    updates.push('notifications_enabled = ?')
    params.push(body.notifications_enabled ? 1 : 0)
  }

  if (body.critical_alert_volume !== undefined) {
    const val = body.critical_alert_volume
    if (typeof val !== 'number' || val < 0 || val > 1)
      return 'critical_alert_volume must be a number between 0.0 and 1.0'
    updates.push('critical_alert_volume = ?')
    params.push(val)
  }

  if (body.default_snooze_option !== undefined) {
    const val = body.default_snooze_option
    if (typeof val !== 'string') return 'default_snooze_option must be a string'
    if (val !== 'tomorrow') {
      const num = parseInt(val, 10)
      if (isNaN(num) || num < 1 || num > 1440 || String(num) !== val)
        return 'default_snooze_option must be "tomorrow" or a string integer 1-1440'
    }
    updates.push('default_snooze_option = ?')
    params.push(val)
  }

  if (body.morning_time !== undefined) {
    const val = body.morning_time
    if (typeof val !== 'string' || !/^\d{2}:\d{2}$/.test(val))
      return 'morning_time must be in HH:MM format'
    const [hours, minutes] = val.split(':').map(Number)
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59)
      return 'morning_time must have valid hours (0-23) and minutes (0-59)'
    updates.push('morning_time = ?')
    params.push(val)
  }

  if (body.wake_time !== undefined) {
    const val = body.wake_time
    if (typeof val !== 'string' || !/^\d{2}:\d{2}$/.test(val))
      return 'wake_time must be in HH:MM format'
    const [hours, minutes] = val.split(':').map(Number)
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59)
      return 'wake_time must have valid hours (0-23) and minutes (0-59)'
    updates.push('wake_time = ?')
    params.push(val)
  }

  if (body.sleep_time !== undefined) {
    const val = body.sleep_time
    if (typeof val !== 'string' || !/^\d{2}:\d{2}$/.test(val))
      return 'sleep_time must be in HH:MM format'
    const [hours, minutes] = val.split(':').map(Number)
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59)
      return 'sleep_time must have valid hours (0-23) and minutes (0-59)'
    updates.push('sleep_time = ?')
    params.push(val)
  }

  return null
}

/** Validate a per-feature AI mode field. */
function validateFeatureMode(
  body: Record<string, unknown>,
  field: string,
  updates: string[],
  params: unknown[],
): string | null {
  if (body[field] === undefined) return null
  if (!VALID_FEATURE_MODES.includes(body[field] as (typeof VALID_FEATURE_MODES)[number]))
    return `${field} must be "off", "sdk", or "api"`
  // Allow saving any valid mode even if the provider isn't available yet.
  // The UI shows an amber warning for unavailable modes, and the feature info
  // popover explains what's missing. This lets users pre-configure modes before
  // the admin sets up the provider.
  updates.push(`${field} = ?`)
  params.push(body[field])
  return null
}

/** Validate AI-related preference fields (context, mode, show scores/signals, per-feature modes). */
function validateAiFields(
  body: Record<string, unknown>,
  updates: string[],
  params: unknown[],
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
    updates.push('ai_context = ?')
    params.push(resolved)
  }

  if (body.ai_mode !== undefined) {
    if (!VALID_AI_MODES.includes(body.ai_mode as (typeof VALID_AI_MODES)[number]))
      return 'ai_mode must be "off" or "on"'
    updates.push('ai_mode = ?')
    params.push(body.ai_mode)
  }

  if (body.ai_show_scores !== undefined) {
    if (typeof body.ai_show_scores !== 'boolean') return 'ai_show_scores must be a boolean'
    updates.push('ai_show_scores = ?')
    params.push(body.ai_show_scores ? 1 : 0)
  }

  if (body.ai_show_signals !== undefined) {
    if (typeof body.ai_show_signals !== 'boolean') return 'ai_show_signals must be a boolean'
    updates.push('ai_show_signals = ?')
    params.push(body.ai_show_signals ? 1 : 0)
  }

  // Per-feature AI mode fields
  const featureModeFields = [
    'ai_enrichment_mode',
    'ai_quicktake_mode',
    'ai_whats_next_mode',
    'ai_insights_mode',
  ]
  for (const field of featureModeFields) {
    const err = validateFeatureMode(body, field, updates, params)
    if (err) return err
  }

  if (body.ai_wn_commentary_unfiltered !== undefined) {
    if (typeof body.ai_wn_commentary_unfiltered !== 'boolean')
      return 'ai_wn_commentary_unfiltered must be a boolean'
    updates.push('ai_wn_commentary_unfiltered = ?')
    params.push(body.ai_wn_commentary_unfiltered ? 1 : 0)
  }

  if (body.ai_wn_highlight !== undefined) {
    if (typeof body.ai_wn_highlight !== 'boolean') return 'ai_wn_highlight must be a boolean'
    updates.push('ai_wn_highlight = ?')
    params.push(body.ai_wn_highlight ? 1 : 0)
  }

  if (body.ai_insights_signal_chips !== undefined) {
    if (typeof body.ai_insights_signal_chips !== 'boolean')
      return 'ai_insights_signal_chips must be a boolean'
    updates.push('ai_insights_signal_chips = ?')
    params.push(body.ai_insights_signal_chips ? 1 : 0)
  }

  if (body.ai_insights_score_chips !== undefined) {
    if (typeof body.ai_insights_score_chips !== 'boolean')
      return 'ai_insights_score_chips must be a boolean'
    updates.push('ai_insights_score_chips = ?')
    params.push(body.ai_insights_score_chips ? 1 : 0)
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
      updates.push(`${field} = ?`)
      params.push(val)
    }
  }

  return null
}

/**
 * Validate all PATCH fields and build the SQL updates/params arrays.
 * Returns a string error message on validation failure, or the validated result.
 */
function validatePatchFields(body: Record<string, unknown>): ValidatedPatch | string {
  const updates: string[] = []
  const params: unknown[] = []

  const generalErr = validateGeneralFields(body, updates, params)
  if (generalErr) return generalErr

  const aiErr = validateAiFields(body, updates, params)
  if (aiErr) return aiErr

  if (updates.length === 0) return 'No preferences to update'

  return { updates, params }
}

const PREFERENCES_SELECT =
  'SELECT default_grouping, default_sort, default_sort_reversed, label_config, priority_display, auto_snooze_minutes, auto_snooze_urgent_minutes, auto_snooze_high_minutes, default_snooze_option, morning_time, wake_time, sleep_time, notifications_enabled, critical_alert_volume, ai_context, ai_mode, ai_show_scores, ai_show_signals, ai_enrichment_mode, ai_quicktake_mode, ai_whats_next_mode, ai_insights_mode, ai_wn_commentary_unfiltered, ai_wn_highlight, ai_insights_signal_chips, ai_insights_score_chips, ai_enrichment_timeout_ms, ai_quicktake_timeout_ms, ai_whats_next_timeout_ms, ai_insights_timeout_ms FROM users WHERE id = ?'

interface PreferencesRow {
  default_grouping: string
  default_sort: string
  default_sort_reversed: number
  label_config: string
  priority_display: string
  auto_snooze_minutes: number
  auto_snooze_urgent_minutes: number
  auto_snooze_high_minutes: number
  default_snooze_option: string
  morning_time: string
  wake_time: string
  sleep_time: string
  notifications_enabled: number
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

/** Fallback row when user record is missing (should not happen in practice). */
const DEFAULT_PREFERENCES_ROW: PreferencesRow = {
  default_grouping: 'project',
  default_sort: 'due_date',
  default_sort_reversed: 0,
  label_config: '[]',
  priority_display: JSON.stringify(DEFAULT_PRIORITY_DISPLAY),
  auto_snooze_minutes: 30,
  auto_snooze_urgent_minutes: 5,
  auto_snooze_high_minutes: 15,
  default_snooze_option: '60',
  morning_time: '09:00',
  wake_time: '07:00',
  sleep_time: '22:00',
  notifications_enabled: 1,
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

function formatPreferencesResponse(row: PreferencesRow) {
  const { labelConfig, priorityDisplay } = parsePreferencesRow(row)
  return {
    ai_available: isAIEnabled(),
    default_grouping: row.default_grouping,
    default_sort: row.default_sort,
    default_sort_reversed: row.default_sort_reversed !== 0,
    label_config: labelConfig,
    priority_display: priorityDisplay,
    auto_snooze_minutes: row.auto_snooze_minutes,
    auto_snooze_urgent_minutes: row.auto_snooze_urgent_minutes,
    auto_snooze_high_minutes: row.auto_snooze_high_minutes,
    default_snooze_option: row.default_snooze_option,
    morning_time: row.morning_time,
    wake_time: row.wake_time,
    sleep_time: row.sleep_time,
    notifications_enabled: row.notifications_enabled !== 0,
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

    const result = validatePatchFields(body)
    if (typeof result === 'string') return badRequest(result)

    const db = getDb()
    const { updates, params } = result
    params.push(user.id)
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params)

    const row = db.prepare(PREFERENCES_SELECT).get(user.id) as PreferencesRow
    return success(formatPreferencesResponse(row))
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'PATCH /api/user/preferences error:', err)
    return handleError(err)
  }
})
