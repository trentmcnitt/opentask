/**
 * WHERE A CUSTOM DATE/TIME PICKER OPENS (Trent, 2026-10-30), one rule for
 * every custom picker — the target and defer menus' Custom…, the selection
 * bar's Target → Custom…, the editor's date fields:
 *
 * - every task in play has the SAME target (the one task's, or the whole
 *   selection's, date and time alike): open on that target ("if the selected
 *   item, or multiple selected items, have an identical target, it should
 *   default to that target");
 * - otherwise — no targets, some missing, or different ones — the TIME is the
 *   user's Default task time (`morningTime`, resolved through its period
 *   link: "anytime you're picking a custom time, [it] should always make sure
 *   it picks up on the default time setting") and the DAY is tomorrow, or the
 *   earliest target's day when that is later.
 *
 * Days are OpenTask days.
 */
import { addDays, openTaskDayOf, periodOpensAt } from '@/lib/opentask-day'

export function customPickerStart({
  from,
  timezone,
  morningTime,
  dayStart,
  now = new Date(),
}: {
  /** The targets in play, one per task (UTC ISO; null = no target). */
  from: readonly (string | null | undefined)[]
  timezone: string
  morningTime: string
  dayStart: string
  now?: Date
}): string {
  const shared =
    from.length > 0 && from.every((iso) => !!iso && Date.parse(iso) === Date.parse(from[0]!))
  if (shared) return new Date(from[0]!).toISOString()
  const tomorrow = addDays(openTaskDayOf(now, timezone, dayStart), 1)
  const days = from
    .filter((iso): iso is string => !!iso)
    .map((iso) => openTaskDayOf(new Date(iso), timezone, dayStart))
  const earliest = days.length > 0 ? days.reduce((a, b) => (b < a ? b : a)) : null
  const day = earliest && earliest > tomorrow ? earliest : tomorrow
  return periodOpensAt(day, morningTime, timezone, dayStart).toISOString()
}
