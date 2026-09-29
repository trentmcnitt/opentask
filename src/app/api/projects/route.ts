/**
 * Projects API routes
 *
 * GET /api/projects - List user's projects + shared projects
 * POST /api/projects - Create a project
 */

import { NextRequest } from 'next/server'
import { getAuthUser } from '@/core/auth'
import { AppError } from '@/core/errors'
import { success, unauthorized, handleError, handleZodError } from '@/lib/api-response'
import { validateProjectCreate } from '@/core/validation'
import { log } from '@/lib/logger'
import { ZodError } from 'zod'
import { createProject, getProjects } from '@/core/projects'
import { withLogging } from '@/lib/with-logging'

export const GET = withLogging(async function GET(request: NextRequest) {
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
    if (!(err instanceof AppError)) log.error('api', 'GET /api/projects error:', err)
    return handleError(err)
  }
})

export const POST = withLogging(async function POST(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const input = validateProjectCreate(await request.json())
    return success(createProject(user.id, input), 201)
  } catch (err) {
    if (err instanceof ZodError) return handleZodError(err)
    if (!(err instanceof AppError)) log.error('api', 'POST /api/projects error:', err)
    return handleError(err)
  }
})
