/**
 * Stats API route
 *
 * GET /api/stats - Get user stats summary (today, week, month, all-time)
 * GET /api/stats?start=YYYY-MM-DD&end=YYYY-MM-DD - Get daily stats for date range
 */

import { NextRequest } from 'next/server'
import { getAuthUser, AuthError } from '@/core/auth'
import { success, unauthorized, badRequest, handleError } from '@/lib/api-response'
import { getStatsSummary, getDailyStats } from '@/core/stats'
import { DateTime } from 'luxon'

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return unauthorized()
    }

    const { searchParams } = new URL(request.url)
    const startDate = searchParams.get('start')
    const endDate = searchParams.get('end')

    // If date range provided, return daily stats for that range
    if (startDate && endDate) {
      // Validate date format and that dates are real
      const start = DateTime.fromISO(startDate)
      const end = DateTime.fromISO(endDate)

      if (!start.isValid || !end.isValid) {
        return badRequest('Invalid date. Use YYYY-MM-DD format with valid dates.')
      }

      if (start > end) {
        return badRequest('Start date must be before or equal to end date.')
      }

      const stats = getDailyStats(user.id, startDate, endDate)
      return success({ stats })
    }

    // Otherwise return summary
    const summary = getStatsSummary(user.id, user.timezone)
    return success(summary)
  } catch (err) {
    if (err instanceof AuthError) {
      return unauthorized(err.message)
    }
    console.error('GET /api/stats error:', err)
    return handleError(err)
  }
}
