/**
 * TODAY'S ALL-CLEAR CARD (Trent, 2026-10-30, E2 of `.tmp/all-done/`): with
 * Late and Today both empty, Today shows "All clear for today" and what comes
 * next. This is the card's "Next" line:
 *
 * - the next period with picked targets coming: the earliest upcoming picked
 *   target's period (`assignSlot`), on its OpenTask day, and how many picked
 *   targets fall in that same period that day — "Morning, 8:30 AM · 2 targets",
 *   with a weekday before it when it is not tomorrow ("Mon · Morning, …");
 * - else the decks set for tomorrow — "on deck tomorrow · 3";
 * - else nothing (the line is left out).
 *
 * Tasks only (no reminders, no quotas). The time is the period's start that
 * day (`periodOpensAt`); a target before every period's start is the time
 * itself, without a period name.
 */
import { DateTime } from 'luxon'
import { addDays, openTaskDayOf, openTaskLocalDay, periodOpensAt } from '@/lib/opentask-day'
import { assignSlot, type TimeSlot } from '@/lib/time-slot-assign'
import { hasPickedTarget } from '@/lib/task-segments'
import { isTracked } from '@/lib/track'
import type { Task } from '@/types'

export function allClearNext(
  tasks: readonly Task[],
  slots: TimeSlot[],
  { now, timezone, dayStart }: { now: Date; timezone: string; dayStart: string },
): string | null {
  const open = tasks.filter((t) => !t.done && !t.is_reminder && !isTracked(t))
  const today = openTaskDayOf(now, timezone, dayStart)
  const tomorrow = addDays(today, 1)
  const ahead = open
    .filter((t) => hasPickedTarget(t) && new Date(t.due_at!) > now)
    .sort((a, b) => Date.parse(a.due_at!) - Date.parse(b.due_at!))
  if (ahead.length > 0) {
    const first = ahead[0]
    const day = openTaskDayOf(new Date(first.due_at!), timezone, dayStart)
    const slot = assignSlot(first, slots, timezone)
    const count = ahead.filter(
      (t) =>
        openTaskDayOf(new Date(t.due_at!), timezone, dayStart) === day &&
        assignSlot(t, slots, timezone)?.id === slot?.id,
    ).length
    const at = slot
      ? periodOpensAt(day, slot.start_time, timezone, dayStart)
      : new Date(first.due_at!)
    const time = DateTime.fromJSDate(at).setZone(timezone).toFormat('h:mm a')
    const when = slot ? `${slot.label}, ${time}` : time
    const dayName = openTaskLocalDay(new Date(first.due_at!), timezone, dayStart).toFormat('ccc')
    const weekday = day === tomorrow ? '' : `${dayName} · `
    return `${weekday}${when} · ${count} ${count === 1 ? 'target' : 'targets'}`
  }
  const decks = open.filter((t) => t.on_deck_day === tomorrow).length
  return decks > 0 ? `on deck tomorrow · ${decks}` : null
}

/** "4 done · 2 moved to tomorrow", a zero part left out; null when both are zero. */
export function allClearCounts(summary: { done: number; moved: number }): string | null {
  const parts = [
    summary.done > 0 ? `${summary.done} done` : null,
    summary.moved > 0 ? `${summary.moved} moved to tomorrow` : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}
