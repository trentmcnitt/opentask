/**
 * THE ONE-DAY MOVE, CLIENT SIDE (2026-11-21): which periods a reminder or a
 * quota prompt waiting today can be moved to, and how a move is drawn before
 * the server's next payload confirms it.
 *
 * The server's rule is RULE RM-MOVE-TARGET (`src/core/tasks/reminder-move.ts`):
 * any period of today other than the one the item is in now (a moved item's
 * "own" period is the one it was moved to), earlier or later, open or not
 * (Trent, 2026-11-27; later periods only until then); never from or to
 * Anytime. This file is
 * that rule, once, for every web surface that offers a move (the dashboard
 * bubble's chips, the /reminders select bar's menu), so the UI never offers a
 * period the server would refuse. `tests/behavioral/rm-move-later.test.ts`
 * holds the two to each other.
 *
 * Instants, never HH:MM minutes: a period that starts before the day start
 * (a 01:00 "Late night" with the 3:00 AM default) opens on the NEXT calendar
 * date, so it is the latest period of the day, not the earliest.
 */
import { openTaskDayOf, periodOpensAt } from '@/lib/opentask-day'
import { byPriorityRank } from '@/lib/priority'
import { applyPromptMoves, type PromptGroup } from '@/lib/quota-prompts'
import { parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'

/** When `slot` opens on the OpenTask day `date`; null for an unparseable start. */
function opensAt(slot: TimeSlot, date: string, timezone: string, dayStart: string): Date | null {
  if (parseHHMM(slot.start_time) === null) return null
  return periodOpensAt(date, slot.start_time, timezone, dayStart)
}

/**
 * The periods an item in `current` (the period it is in NOW; null = Anytime)
 * can be moved to for today: every period of `now`'s OpenTask day but its
 * own, earlier and later, open or not, in day order (RULE RM-MOVE-TARGET,
 * 2026-11-27). Anytime has none, and is never one.
 */
export function movePeriodsToday(
  current: TimeSlot | null,
  slots: readonly TimeSlot[],
  now: Date,
  timezone: string,
  dayStart: string,
): TimeSlot[] {
  if (!current) return []
  const date = openTaskDayOf(now, timezone, dayStart)
  if (!opensAt(current, date, timezone, dayStart)) return []
  return slots
    .filter((slot) => slot.id !== current.id)
    .map((slot) => ({ slot, at: opensAt(slot, date, timezone, dayStart) }))
    .filter((x): x is { slot: TimeSlot; at: Date } => x.at !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((x) => x.slot)
}

/**
 * The periods EVERY one of a selection can move to (`movePeriodsToday` of
 * each, intersected): every period none of them is in now. One request
 * moves them all to one period, and the server refuses the whole request if
 * any one of them can't go there. Nothing selected, or one in Anytime: none.
 */
export function movePeriodsForAll(
  currents: readonly (TimeSlot | null)[],
  slots: readonly TimeSlot[],
  now: Date,
  timezone: string,
  dayStart: string,
): TimeSlot[] {
  if (currents.length === 0) return []
  let common = movePeriodsToday(currents[0], slots, now, timezone, dayStart)
  for (const current of currents.slice(1)) {
    if (common.length === 0) break
    const ids = new Set(
      movePeriodsToday(current, slots, now, timezone, dayStart).map((slot) => slot.id),
    )
    common = common.filter((slot) => ids.has(slot.id))
  }
  return common
}

/** The part of a reminder group a move touches (`ReminderGroup`'s). */
export interface MovableGroup<
  T extends { id: number; priority?: number | null },
> extends PromptGroup {
  reminders: T[]
  count: number
}

/**
 * Groups with each moved item drawn in its new period — reminders by id,
 * prompts by `prompt_key` (`moves`: item → slot id). Idempotent: an item
 * already in its target period, or not waiting in any group, is left alone,
 * so re-applying a move to a payload that already has it changes nothing. A
 * moved reminder takes its place by the server's own order (priority rank,
 * then id — `getRemindersBySlot`), so the next payload doesn't shuffle it.
 * `GET /api/reminders` sends a group for every period, so the target is
 * there; a move to a period missing from `groups` is skipped.
 */
export function applyDayMoves<
  T extends { id: number; priority?: number | null },
  G extends MovableGroup<T>,
>(groups: G[], moves: ReadonlyMap<number | string, number>): G[] {
  if (moves.size === 0) return groups
  const promptMoves = new Map<string, number>()
  let out = groups
  for (const [item, toSlotId] of moves) {
    if (typeof item === 'string') {
      promptMoves.set(item, toSlotId)
      continue
    }
    const toIndex = out.findIndex((g) => g.slot?.id === toSlotId)
    const fromIndex = out.findIndex(
      (g, i) => i !== toIndex && g.reminders.some((r) => r.id === item),
    )
    if (toIndex < 0 || fromIndex < 0) continue
    const moving = out[fromIndex].reminders.find((r) => r.id === item)!
    out = out.map((g, i) => {
      if (i === fromIndex) {
        const reminders = g.reminders.filter((r) => r.id !== item)
        return { ...g, reminders, count: reminders.length }
      }
      if (i === toIndex) {
        const reminders = [...g.reminders, moving].sort(
          (a, b) => byPriorityRank(a, b) || a.id - b.id,
        )
        return { ...g, reminders, count: reminders.length }
      }
      return g
    })
  }
  return promptMoves.size > 0 ? applyPromptMoves(out, promptMoves) : out
}

/**
 * The move's toast, in the server's words (`describeMove` in
 * `src/core/tasks/reminder-move.ts`, the undo entry's description): shown at
 * once, before the server answers, like a consider's.
 */
export function moveMessage(titles: readonly string[], label: string): string {
  const what = titles.length === 1 ? `“${titles[0]}”` : `${titles.length}`
  return `Moved ${what} to ${label} for today`
}
