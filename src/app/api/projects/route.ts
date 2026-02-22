/**
 * Projects API routes
 *
 * GET /api/projects - List user's projects + shared projects
 * POST /api/projects - Create a project
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { getDb } from '@/core/db'
import { nowUtc } from '@/core/recurrence'
import { validateProjectCreate } from '@/core/validation'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'
import { formatProjectResponse, type ProjectRow } from '@/lib/format-project'
import { LABEL_COLOR_NAMES } from '@/lib/label-colors'
import { getProjects } from '@/core/projects'

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const projects = getProjects(user.id)

    return success({
      projects,
      count: projects.length,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    log.error('api', 'GET /api/projects error:', err)
    return handleError(err)
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const input = validateProjectCreate(await request.json())

    const name = input.name.trim()
    const shared = input.shared
    const sortOrder = input.sort_order

    const db = getDb()
    const now = nowUtc()

    // Auto-assign a random color if none provided
    let color = input.color ?? null
    if (!color) {
      const existingColors = db
        .prepare('SELECT color FROM projects WHERE owner_id = ? AND color IS NOT NULL')
        .all(user.id) as { color: string }[]
      const usedColors = new Set(existingColors.map((r) => r.color))
      const availableColors = LABEL_COLOR_NAMES.filter((c) => !usedColors.has(c))
      color =
        availableColors.length > 0
          ? availableColors[Math.floor(Math.random() * availableColors.length)]
          : LABEL_COLOR_NAMES[Math.floor(Math.random() * LABEL_COLOR_NAMES.length)]
    }

    const result = db
      .prepare(
        `
      INSERT INTO projects (name, owner_id, shared, sort_order, color, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(name, user.id, shared ? 1 : 0, sortOrder, color, now)

    const projectId = Number(result.lastInsertRowid)

    const project = db
      .prepare(
        'SELECT id, name, owner_id, shared, sort_order, color, created_at, 0 AS active_count, 0 AS overdue_count FROM projects WHERE id = ?',
      )
      .get(projectId) as ProjectRow

    return success(formatProjectResponse(project), 201)
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'POST /api/projects error:', err)
    return handleError(err)
  }
}
