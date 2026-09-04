/**
 * The Today view's grouping (REDESIGN-V03 §7.3), kept pure so the rules that
 * decide what reaches the front door can be pinned by behavioral tests — an
 * item silently missing from Today looks identical to an empty day.
 */
import { DateTime } from 'luxon'
import { groupBySlot, type TimeSlot } from '@/lib/time-slot-assign'
import { effectiveDueAt } from '@/core/recurrence/occurrence'
import { isTracked } from '@/lib/track'
import type { Task } from '@/types'

/** Where items with no time of day land, after the timed slots. */
export const UNSLOTTED_LABEL = 'Anytime today'

export interface SlotViewGroup {
  label: string
  tasks: Task[]
}

export function groupByTimeSlot(
  tasks: Task[],
  slots: TimeSlot[],
  timezone: string,
  now: Date = new Date(),
): SlotViewGroup[] {
  if (tasks.length === 0) return []

  // §7.3: the front door is TODAY, not the whole corpus. Due-ness comes from
  // §4.6's derivation rather than raw due_at, so a recurring item whose date
  // froze months ago doesn't wrongly appear, and one that genuinely recurs
  // today does — even if its stored due_at disagrees.
  //
  // Undated items are kept: they can't be "not today".
  //
  // Tracked items (§5) are kept unconditionally and land in the un-slotted
  // group. A quota is a counter over a period — "eggs, 2x this week" — so its
  // period contains today by definition; asking its rrule whether it "occurs"
  // today is the wrong question (the §9 migration rewrote quota rules to the
  // bare period, e.g. FREQ=WEEKLY, which rrule.js would place on one arbitrary
  // weekday and hide the row the other six days). Nor does its stale due_at
  // name a time of day. §7.3: tracked items must not become invisible from
  // the front door, and belong in "Anytime today" as progress rows.
  const endOfToday = DateTime.fromJSDate(now).setZone(timezone).endOf('day').toJSDate()

  const tracked = tasks.filter((task) => isTracked(task))
  const todays = tasks.filter((task) => {
    if (isTracked(task)) return false
    if (!task.due_at && !task.rrule) return true
    const effective = effectiveDueAt(task, timezone, now)
    if (!effective) return false
    return effective.getTime() <= endOfToday.getTime()
  })

  if (todays.length === 0 && tracked.length === 0) return []

  const grouped = groupBySlot(todays, slots, timezone)
  const out: SlotViewGroup[] = []

  for (const group of grouped) {
    if (group.slot === null) {
      const items = [...tracked, ...group.items]
      if (items.length > 0) {
        out.push({ label: UNSLOTTED_LABEL, tasks: items })
      }
      continue
    }
    out.push({ label: group.slot.label, tasks: group.items })
  }

  return out
}
