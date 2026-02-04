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

const VALID_GROUPINGS = ['time', 'project'] as const

const DEFAULT_PRIORITY_DISPLAY: PriorityDisplayConfig = {
  trailingDot: true,
  colorTitle: false,
  rightBorder: false,
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) return unauthorized()

    const db = getDb()
    const row = db
      .prepare('SELECT default_grouping, label_config, priority_display FROM users WHERE id = ?')
      .get(user.id) as
      | { default_grouping: string; label_config: string; priority_display: string }
      | undefined

    let labelConfig: LabelConfig[] = []
    try {
      labelConfig = row?.label_config ? JSON.parse(row.label_config) : []
    } catch {
      labelConfig = []
    }

    let priorityDisplay: PriorityDisplayConfig = DEFAULT_PRIORITY_DISPLAY
    try {
      priorityDisplay = row?.priority_display
        ? JSON.parse(row.priority_display)
        : DEFAULT_PRIORITY_DISPLAY
    } catch {
      priorityDisplay = DEFAULT_PRIORITY_DISPLAY
    }

    return success({
      default_grouping: row?.default_grouping ?? 'project',
      label_config: labelConfig,
      priority_display: priorityDisplay,
    })
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

export async function PATCH(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) return unauthorized()

    const body = await request.json()

    if (body.default_grouping !== undefined && !VALID_GROUPINGS.includes(body.default_grouping)) {
      return badRequest('default_grouping must be "time" or "project"')
    }

    let validatedLabelConfig: LabelConfig[] | undefined
    if (body.label_config !== undefined) {
      const validated = validateLabelConfig(body.label_config)
      if (typeof validated === 'string') return badRequest(validated)
      validatedLabelConfig = validated
    }

    let validatedPriorityDisplay: PriorityDisplayConfig | undefined
    if (body.priority_display !== undefined) {
      const validated = validatePriorityDisplay(body.priority_display)
      if (typeof validated === 'string') return badRequest(validated)
      validatedPriorityDisplay = validated
    }

    if (
      body.default_grouping === undefined &&
      body.label_config === undefined &&
      body.priority_display === undefined
    ) {
      return badRequest('No preferences to update')
    }

    const db = getDb()
    const updates: string[] = []
    const params: unknown[] = []

    if (body.default_grouping !== undefined) {
      updates.push('default_grouping = ?')
      params.push(body.default_grouping)
    }

    if (validatedLabelConfig !== undefined) {
      updates.push('label_config = ?')
      params.push(JSON.stringify(validatedLabelConfig))
    }

    if (validatedPriorityDisplay !== undefined) {
      updates.push('priority_display = ?')
      params.push(JSON.stringify(validatedPriorityDisplay))
    }

    params.push(user.id)
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params)

    // Read back current state
    const row = db
      .prepare('SELECT default_grouping, label_config, priority_display FROM users WHERE id = ?')
      .get(user.id) as { default_grouping: string; label_config: string; priority_display: string }

    let labelConfig: LabelConfig[] = []
    try {
      labelConfig = JSON.parse(row.label_config)
    } catch {
      labelConfig = []
    }

    let priorityDisplay: PriorityDisplayConfig = DEFAULT_PRIORITY_DISPLAY
    try {
      priorityDisplay = JSON.parse(row.priority_display)
    } catch {
      priorityDisplay = DEFAULT_PRIORITY_DISPLAY
    }

    return success({
      default_grouping: row.default_grouping,
      label_config: labelConfig,
      priority_display: priorityDisplay,
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'PATCH /api/user/preferences error:', err)
    return handleError(err)
  }
}
