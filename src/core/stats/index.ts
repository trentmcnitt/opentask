/**
 * User daily stats module
 *
 * Tracks aggregate stats with daily granularity in user's timezone.
 */

import { getDb } from '@/core/db'
import { DateTime } from 'luxon'
import type { DailyStat, StatsSummary } from '@/types'

export type StatType = 'completions' | 'tasks_created' | 'snoozes'

/**
 * Increment a daily stat for a user
 *
 * Uses upsert to either create a new row or increment the existing value.
 * The date is computed from the user's timezone.
 *
 * @param userId The user ID
 * @param statType Which stat to increment
 * @param userTimezone The user's timezone (e.g., 'America/Chicago')
 * @param delta Amount to increment (default 1, use negative for decrement)
 */
const VALID_STAT_TYPES = ['completions', 'tasks_created', 'snoozes'] as const

export function incrementDailyStat(
  userId: number,
  statType: StatType,
  userTimezone: string,
  delta: number = 1,
): void {
  // Runtime validation to prevent SQL injection (defense-in-depth)
  if (!VALID_STAT_TYPES.includes(statType)) {
    throw new Error(`Invalid stat type: ${statType}`)
  }

  const db = getDb()

  // Get today's date in user's timezone
  const userNow = DateTime.now().setZone(userTimezone)
  const dateStr = userNow.toFormat('yyyy-MM-dd')

  // Use SQLite upsert (INSERT ... ON CONFLICT ... DO UPDATE)
  db.prepare(
    `
    INSERT INTO user_daily_stats (user_id, date, ${statType})
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET ${statType} = ${statType} + ?
  `,
  ).run(userId, dateStr, Math.max(0, delta), delta)

  // Ensure we don't go below 0 after decrement
  if (delta < 0) {
    db.prepare(
      `
      UPDATE user_daily_stats
      SET ${statType} = MAX(0, ${statType})
      WHERE user_id = ? AND date = ?
    `,
    ).run(userId, dateStr)
  }
}

/**
 * Get daily stats for a user within a date range
 *
 * @param userId The user ID
 * @param startDate Start date (YYYY-MM-DD)
 * @param endDate End date (YYYY-MM-DD), inclusive
 */
export function getDailyStats(userId: number, startDate: string, endDate: string): DailyStat[] {
  const db = getDb()

  const rows = db
    .prepare(
      `
    SELECT id, user_id, date, completions, tasks_created, snoozes
    FROM user_daily_stats
    WHERE user_id = ? AND date >= ? AND date <= ?
    ORDER BY date ASC
  `,
    )
    .all(userId, startDate, endDate) as DailyStat[]

  return rows
}

/**
 * Get a stats summary for a user
 *
 * Returns today's stats plus aggregates for week, month, and all time.
 *
 * @param userId The user ID
 * @param userTimezone The user's timezone
 */
export function getStatsSummary(userId: number, userTimezone: string): StatsSummary {
  const db = getDb()

  // Get today's date in user's timezone
  const userNow = DateTime.now().setZone(userTimezone)
  const todayStr = userNow.toFormat('yyyy-MM-dd')
  const weekAgoStr = userNow.minus({ days: 7 }).toFormat('yyyy-MM-dd')
  const monthAgoStr = userNow.minus({ days: 30 }).toFormat('yyyy-MM-dd')

  // Get today's stats
  const today = db
    .prepare(
      `
    SELECT id, user_id, date, completions, tasks_created, snoozes
    FROM user_daily_stats
    WHERE user_id = ? AND date = ?
  `,
    )
    .get(userId, todayStr) as DailyStat | undefined

  // Get week aggregate
  const weekStats = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(completions), 0) as completions,
      COALESCE(SUM(tasks_created), 0) as tasks_created,
      COALESCE(SUM(snoozes), 0) as snoozes
    FROM user_daily_stats
    WHERE user_id = ? AND date >= ?
  `,
    )
    .get(userId, weekAgoStr) as { completions: number; tasks_created: number; snoozes: number }

  // Get month aggregate
  const monthStats = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(completions), 0) as completions,
      COALESCE(SUM(tasks_created), 0) as tasks_created,
      COALESCE(SUM(snoozes), 0) as snoozes
    FROM user_daily_stats
    WHERE user_id = ? AND date >= ?
  `,
    )
    .get(userId, monthAgoStr) as { completions: number; tasks_created: number; snoozes: number }

  // Get all-time aggregate
  const allTimeStats = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(completions), 0) as completions,
      COALESCE(SUM(tasks_created), 0) as tasks_created,
      COALESCE(SUM(snoozes), 0) as snoozes
    FROM user_daily_stats
    WHERE user_id = ?
  `,
    )
    .get(userId) as { completions: number; tasks_created: number; snoozes: number }

  return {
    today: today ?? null,
    week: {
      completions: weekStats.completions,
      tasks_created: weekStats.tasks_created,
      snoozes: weekStats.snoozes,
    },
    month: {
      completions: monthStats.completions,
      tasks_created: monthStats.tasks_created,
      snoozes: monthStats.snoozes,
    },
    all_time: {
      completions: allTimeStats.completions,
      tasks_created: allTimeStats.tasks_created,
      snoozes: allTimeStats.snoozes,
    },
  }
}
