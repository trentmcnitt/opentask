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

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const db = getDb()

    // Get user's own projects + shared projects
    const projects = db
      .prepare(
        `
      SELECT id, name, owner_id, shared, sort_order, created_at
      FROM projects
      WHERE owner_id = ? OR shared = 1
      ORDER BY sort_order ASC, name ASC
    `,
      )
      .all(user.id) as ProjectRow[]

    // Transform to API format
    const formattedProjects = projects.map(formatProjectResponse)

    return success({
      projects: formattedProjects,
      count: formattedProjects.length,
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

    const result = db
      .prepare(
        `
      INSERT INTO projects (name, owner_id, shared, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(name, user.id, shared ? 1 : 0, sortOrder, now)

    const projectId = Number(result.lastInsertRowid)

    const project = db
      .prepare(
        'SELECT id, name, owner_id, shared, sort_order, created_at FROM projects WHERE id = ?',
      )
      .get(projectId) as {
      id: number
      name: string
      owner_id: number
      shared: number
      sort_order: number
      created_at: string
    }

    return success(formatProjectResponse(project), 201)
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    if (err instanceof ZodError) return handleZodError(err)
    log.error('api', 'POST /api/projects error:', err)
    return handleError(err)
  }
}
