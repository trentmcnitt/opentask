/**
 * Projects API routes
 *
 * GET /api/projects - List user's projects + shared projects
 * POST /api/projects - Create a project
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { getDb } from '@/core/db'
import { nowUtc } from '@/core/recurrence'
import type { Project } from '@/types'

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
    `
      )
      .all(user.id) as Array<{
      id: number
      name: string
      owner_id: number
      shared: number
      sort_order: number
      created_at: string
    }>

    // Transform to API format
    const formattedProjects: Project[] = projects.map((p) => ({
      id: p.id,
      name: p.name,
      owner_id: p.owner_id,
      shared: p.shared === 1,
      sort_order: p.sort_order,
      created_at: p.created_at,
    }))

    return success({
      projects: formattedProjects,
      count: formattedProjects.length,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    console.error('GET /api/projects error:', err)
    return handleError(err)
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const body = await request.json()

    if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
      return badRequest('Project name is required')
    }

    const name = body.name.trim()
    const shared = body.shared === true
    const sortOrder = typeof body.sort_order === 'number' ? body.sort_order : 0

    const db = getDb()
    const now = nowUtc()

    const result = db
      .prepare(
        `
      INSERT INTO projects (name, owner_id, shared, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(name, user.id, shared ? 1 : 0, sortOrder, now)

    const projectId = Number(result.lastInsertRowid)

    const project = db
      .prepare('SELECT id, name, owner_id, shared, sort_order, created_at FROM projects WHERE id = ?')
      .get(projectId) as {
      id: number
      name: string
      owner_id: number
      shared: number
      sort_order: number
      created_at: string
    }

    return success(
      {
        id: project.id,
        name: project.name,
        owner_id: project.owner_id,
        shared: project.shared === 1,
        sort_order: project.sort_order,
        created_at: project.created_at,
      },
      201
    )
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    console.error('POST /api/projects error:', err)
    return handleError(err)
  }
}
