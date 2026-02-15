/**
 * User preferences API
 *
 * GET  /api/user/preferences - Get user preferences
 * PATCH /api/user/preferences - Update user preferences
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { getDb } from '@/core/db'
import { LABEL_COLOR_NAMES } from '@/lib/label-colors'
import { log } from '@/lib/logger'
import type { LabelConfig, LabelColor, PriorityDisplayConfig } from '@/types'

const VALID_GROUPINGS = ['time', 'project', 'unified'] as const
const VALID_AI_MODES = ['off', 'on'] as const
const VALID_WHATS_NEXT_MODELS = ['haiku', 'claude-opus-4-6'] as const

const DEFAULT_PRIORITY_DISPLAY: PriorityDisplayConfig = {
  trailingDot: true,
  colorTitle: false,
  rightBorder: false,
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
      ? JSON.parse(row.priority_display)
      : DEFAULT_PRIORITY_DISPLAY
  } catch {
    priorityDisplay = DEFAULT_PRIORITY_DISPLAY
  }

  return { labelConfig, priorityDisplay }
}

export async function GET(request: NextRequest) {
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
}

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

function validatePriorityDisplay(input: unknown): PriorityDisplayConfig | string {
  if (!input || typeof input !== 'object') {
    return 'priority_display must be an object'
  }
  const obj = input as Record<string, unknown>
  if (typeof obj.trailingDot !== 'boolean') {
    return 'priority_display.trailingDot must be a boolean'
  }
  if (typeof obj.colorTitle !== 'boolean') {
    return 'priority_display.colorTitle must be a boolean'
  }
  if (typeof obj.rightBorder !== 'boolean') {
    return 'priority_display.rightBorder must be a boolean'
  }
  return {
    trailingDot: obj.trailingDot,
    colorTitle: obj.colorTitle,
    rightBorder: obj.rightBorder,
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

/** Validate AI-related preference fields (context, mode, show scores/signals). */
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

  if (body.ai_show_whats_next !== undefined) {
    if (typeof body.ai_show_whats_next !== 'boolean') return 'ai_show_whats_next must be a boolean'
    updates.push('ai_show_whats_next = ?')
    params.push(body.ai_show_whats_next ? 1 : 0)
  }

  if (body.ai_show_insights !== undefined) {
    if (typeof body.ai_show_insights !== 'boolean') return 'ai_show_insights must be a boolean'
    updates.push('ai_show_insights = ?')
    params.push(body.ai_show_insights ? 1 : 0)
  }

  if (body.ai_show_commentary !== undefined) {
    if (typeof body.ai_show_commentary !== 'boolean') return 'ai_show_commentary must be a boolean'
    updates.push('ai_show_commentary = ?')
    params.push(body.ai_show_commentary ? 1 : 0)
  }

  if (body.ai_whats_next_model !== undefined) {
    if (
      !VALID_WHATS_NEXT_MODELS.includes(
        body.ai_whats_next_model as (typeof VALID_WHATS_NEXT_MODELS)[number],
      )
    )
      return `ai_whats_next_model must be one of: ${VALID_WHATS_NEXT_MODELS.join(', ')}`
    updates.push('ai_whats_next_model = ?')
    params.push(body.ai_whats_next_model)
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
  'SELECT default_grouping, label_config, priority_display, auto_snooze_minutes, default_snooze_option, morning_time, wake_time, sleep_time, ai_context, ai_mode, ai_show_scores, ai_show_signals, ai_show_whats_next, ai_show_insights, ai_show_commentary, ai_whats_next_model, ai_wn_commentary_unfiltered, ai_wn_highlight, ai_insights_signal_chips, ai_insights_score_chips FROM users WHERE id = ?'

interface PreferencesRow {
  default_grouping: string
  label_config: string
  priority_display: string
  auto_snooze_minutes: number
  default_snooze_option: string
  morning_time: string
  wake_time: string
  sleep_time: string
  ai_context: string | null
  ai_mode: string
  ai_show_scores: number
  ai_show_signals: number
  ai_show_whats_next: number
  ai_show_insights: number
  ai_show_commentary: number
  ai_whats_next_model: string
  ai_wn_commentary_unfiltered: number
  ai_wn_highlight: number
  ai_insights_signal_chips: number
  ai_insights_score_chips: number
}

/** Fallback row when user record is missing (should not happen in practice). */
const DEFAULT_PREFERENCES_ROW: PreferencesRow = {
  default_grouping: 'project',
  label_config: '[]',
  priority_display: JSON.stringify(DEFAULT_PRIORITY_DISPLAY),
  auto_snooze_minutes: 30,
  default_snooze_option: '60',
  morning_time: '09:00',
  wake_time: '07:00',
  sleep_time: '22:00',
  ai_context: null,
  ai_mode: 'on',
  ai_show_scores: 1,
  ai_show_signals: 1,
  ai_show_whats_next: 1,
  ai_show_insights: 1,
  ai_show_commentary: 1,
  ai_whats_next_model: 'haiku',
  ai_wn_commentary_unfiltered: 0,
  ai_wn_highlight: 1,
  ai_insights_signal_chips: 1,
  ai_insights_score_chips: 1,
}

function formatPreferencesResponse(row: PreferencesRow) {
  const { labelConfig, priorityDisplay } = parsePreferencesRow(row)
  return {
    default_grouping: row.default_grouping,
    label_config: labelConfig,
    priority_display: priorityDisplay,
    auto_snooze_minutes: row.auto_snooze_minutes,
    default_snooze_option: row.default_snooze_option,
    morning_time: row.morning_time,
    wake_time: row.wake_time,
    sleep_time: row.sleep_time,
    ai_context: row.ai_context,
    ai_mode: row.ai_mode,
    ai_show_scores: row.ai_show_scores !== 0,
    ai_show_signals: row.ai_show_signals !== 0,
    ai_show_whats_next: row.ai_show_whats_next !== 0,
    ai_show_insights: row.ai_show_insights !== 0,
    ai_show_commentary: row.ai_show_commentary !== 0,
    ai_whats_next_model: row.ai_whats_next_model,
    ai_wn_commentary_unfiltered: row.ai_wn_commentary_unfiltered !== 0,
    ai_wn_highlight: row.ai_wn_highlight !== 0,
    ai_insights_signal_chips: row.ai_insights_signal_chips !== 0,
    ai_insights_score_chips: row.ai_insights_score_chips !== 0,
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) return unauthorized()

    const body = await request.json()
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
}
