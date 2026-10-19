/**
 * A user's rollover time, read from the database (task queue). Apart from the
 * switch (`task-queue.ts`), which must stay free of the database: the browser
 * bundle reaches the switch through `format-task.ts`.
 */
import { getDb } from '@/core/db'
import { rolloverTimeOf } from '@/lib/opentask-day'
import { taskQueueEnabled } from './task-queue'

/** A user's rollover time (HH:MM): the earliest period's start, else morning_time. */
export function rolloverTimeForUser(userId: number): string {
  const db = getDb()
  const slots = db.prepare('SELECT start_time FROM time_slots WHERE user_id = ?').all(userId) as {
    start_time: string
  }[]
  const user = db.prepare('SELECT morning_time FROM users WHERE id = ?').get(userId) as
    | { morning_time: string | null }
    | undefined
  return rolloverTimeOf(slots, user?.morning_time ?? '09:00')
}

/**
 * The rollover time attempts count OpenTask days from (B7) — the owner's,
 * with the switch on — or null (calendar days, the switch off). For the
 * writers that checkpoint attempts outside `rowToTask` (the put-back).
 */
export function attemptsRolloverTime(ownerId: number): string | null {
  return taskQueueEnabled() ? rolloverTimeForUser(ownerId) : null
}
