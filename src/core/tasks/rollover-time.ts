/**
 * A user's rollover time, read from the database (task queue). Apart from the
 * switch (`task-queue.ts`), which must stay free of the database: the browser
 * bundle reaches the switch through `format-task.ts`.
 */
import { getDayStart } from '@/core/users/anchor-times'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import {
  hasRelativeTarget,
  isDeadlineAnchored,
  type LeadContext,
  type RepeatSchedule,
} from '@/lib/task-segments'
import { taskQueueEnabled } from './task-queue'

/**
 * A user's rollover time (HH:MM): their "Day starts at" (2026-10-23,
 * `getDayStart`) — a custom time, a linked period's start, or, unset, the
 * fixed 3:00 AM default (`DEFAULT_DAY_START`, 2026-10-24). Every day-keyed
 * server reader goes through here (or `dayBoundaryForUser`).
 */
export function rolloverTimeForUser(userId: number): string {
  return getDayStart(userId).time
}

/**
 * THE DAY BOUNDARY of the day-keyed surfaces (2026-10-23, "one day boundary
 * everywhere"): the Reminders screen's roster and "considered today", quota
 * prompts and their day keys, a daily quota's count, and the slot nag. With
 * the task queue's switch on it is the user's day start
 * (`rolloverTimeForUser`); off, midnight (`CALENDAR_DAY_START`) — the switch
 * keeps a server without the queue exactly as it was, like attempts
 * (`attemptsRolloverTime`).
 */
export function dayBoundaryForUser(userId: number): string {
  return taskQueueEnabled() ? rolloverTimeForUser(userId) : CALENDAR_DAY_START
}

/**
 * The rollover time attempts count OpenTask days from (B7) — the owner's,
 * with the switch on — or null (calendar days, the switch off). For the
 * writers that checkpoint attempts outside `rowToTask` (the put-back).
 */
export function attemptsRolloverTime(ownerId: number): string | null {
  return taskQueueEnabled() ? rolloverTimeForUser(ownerId) : null
}

/**
 * The lead context an ADVANCE needs (the deadlines page, 2026-10-22): only a
 * deadline-anchored repeat with no relative target has a lead day to derive
 * for its next occurrence (`occurrenceDates`' `leadFrom`); anything else,
 * undefined (no database read).
 */
export function leadContextFor(
  task: RepeatSchedule & { user_id: number },
  now: Date = new Date(),
): LeadContext | undefined {
  if (!isDeadlineAnchored(task) || hasRelativeTarget(task)) return undefined
  return { rolloverTime: rolloverTimeForUser(task.user_id), now }
}
