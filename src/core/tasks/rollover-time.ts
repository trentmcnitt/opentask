/**
 * A user's rollover time, read from the database (task queue). Apart from the
 * switch (`task-queue.ts`), which must stay free of the database: the browser
 * bundle reaches the switch through `format-task.ts`.
 */
import { listTimeSlots } from '@/core/time-slots'
import { getAnchorTimes } from '@/core/users/anchor-times'
import { rolloverTimeOf } from '@/lib/opentask-day'
import { taskQueueEnabled } from './task-queue'

/**
 * A user's rollover time (HH:MM): the earliest period's start, else the
 * Morning time. Morning only counts with no periods, when nothing can link to
 * one, but it is still read through the resolver like every other reader.
 */
export function rolloverTimeForUser(userId: number): string {
  const slots = listTimeSlots(userId)
  return rolloverTimeOf(slots, getAnchorTimes(userId, slots).morning.time)
}

/**
 * The rollover time attempts count OpenTask days from (B7) — the owner's,
 * with the switch on — or null (calendar days, the switch off). For the
 * writers that checkpoint attempts outside `rowToTask` (the put-back).
 */
export function attemptsRolloverTime(ownerId: number): string | null {
  return taskQueueEnabled() ? rolloverTimeForUser(ownerId) : null
}
