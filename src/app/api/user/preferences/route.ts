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
import type { LabelConfig, LabelColor } from '@/types'

const VALID_GROUPINGS = ['time', 'project'] as const

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) return unauthorized()

    const db = getDb()
    const row = db
      .prepare('SELECT default_grouping, label_config FROM users WHERE id = ?')
      .get(user.id) as { default_grouping: string; label_config: string } | undefined

    let labelConfig: LabelConfig[] = []
    try {
      labelConfig = row?.label_config ? JSON.parse(row.label_config) : []
    } catch {
      labelConfig = []
    }

    return success({
      default_grouping: row?.default_grouping ?? 'project',
      label_config: labelConfig,
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
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

    if (body.default_grouping === undefined && body.label_config === undefined) {
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

    params.push(user.id)
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params)

    // Read back current state
    const row = db
      .prepare('SELECT default_grouping, label_config FROM users WHERE id = ?')
      .get(user.id) as { default_grouping: string; label_config: string }

    let labelConfig: LabelConfig[] = []
    try {
      labelConfig = JSON.parse(row.label_config)
    } catch {
      labelConfig = []
    }

    return success({
      default_grouping: row.default_grouping,
      label_config: labelConfig,
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    return handleError(err)
  }
}
