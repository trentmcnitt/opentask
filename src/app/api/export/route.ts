/**
 * Data Export API
 *
 * GET /api/export?format=json         — Export all data as JSON
 * GET /api/export?format=csv&type=tasks    — Export tasks as CSV
 * GET /api/export?format=csv&type=projects — Export projects as CSV
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, AuthError } from '@/core/auth'
import { success, badRequest, unauthorized, handleError } from '@/lib/api-response'
import { exportUserData, tasksToCsv, projectsToCsv } from '@/core/export'
import { log } from '@/lib/logger'
import { withLogging } from '@/lib/with-logging'

export const GET = withLogging(async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)

    const { searchParams } = new URL(request.url)
    const format = searchParams.get('format') || 'json'

    if (format !== 'json' && format !== 'csv') {
      return badRequest('Invalid format. Must be "json" or "csv".')
    }

    const data = exportUserData(user.id)
    const today = new Date().toISOString().slice(0, 10)

    if (format === 'json') {
      return success({
        tasks: data.tasks,
        projects: data.projects,
        completions: data.completions,
        exported_at: new Date().toISOString(),
      })
    }

    // CSV format requires a type parameter
    const type = searchParams.get('type')
    if (!type || (type !== 'tasks' && type !== 'projects')) {
      return badRequest('CSV export requires type parameter: "tasks" or "projects".')
    }

    const csv = type === 'tasks' ? tasksToCsv(data.tasks) : projectsToCsv(data.projects)
    const filename = `opentask-${type}-${today}.csv`

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    if (err instanceof AuthError) return unauthorized(err.message)
    log.error('api', 'GET /api/export error:', err)
    return handleError(err)
  }
})
