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

/**
 * Where one-offs with no due date land: last, folded by default, and named
 * for what they are. They used to sit under "Anytime today", which was a
 * claim about the day that none of them made (Trent, 2026-09-04: a one-off
 * that never had a date "is a very different thing than anytime today").
 */
export const UNDATED_LABEL = 'Undated'

/**
 * Items timed before the first slot's boundary (a 6:30 walk when the day's
 * first slot starts at 7:00) get a group named by that boundary, first.
 */
export function earlySlotLabel(slots: TimeSlot[]): string {
  const first = [...slots].sort((a, b) => a.start_time.localeCompare(b.start_time))[0]
  if (!first) return 'Timed'
  const parsed = DateTime.fromFormat(first.start_time, 'HH:mm')
  return `Before ${parsed.isValid ? parsed.toFormat('h:mm a') : first.start_time}`
}

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
  // Tracked items (§5) are not day-grouped at all: a quota is a counter over a
  // period, so asking its rrule whether it "occurs" today is the wrong question
  // (the §9 migration rewrote quota rules to the bare period, e.g. FREQ=WEEKLY,
  // which rrule.js would place on one arbitrary weekday). They have their own
  // instrument panel above the day — see `trackedItems` and TrackPanel — which
  // is how §7.3's "must not become invisible from the front door" is met.
  const endOfToday = DateTime.fromJSDate(now).setZone(timezone).endOf('day').toJSDate()

  const todays = tasks.filter((task) => {
    if (isTracked(task)) return false
    if (!task.due_at && !task.rrule) return true
    const effective = effectiveDueAt(task, timezone, now)
    if (!effective) return false
    return effective.getTime() <= endOfToday.getTime()
  })

  if (todays.length === 0) return []

  const grouped = groupBySlot(todays, slots, timezone)
  const out: SlotViewGroup[] = []
  let early: Task[] = []
  let undated: Task[] = []

  for (const group of grouped) {
    if (group.slot === null) {
      // The un-slotted set is two different things: timed items earlier than
      // every boundary, and items with no date at all.
      early = group.items.filter((t) => !!t.due_at)
      undated = group.items.filter((t) => !t.due_at)
      continue
    }
    out.push({ label: group.slot.label, tasks: group.items })
  }

  if (early.length > 0) out.unshift({ label: earlySlotLabel(slots), tasks: early })
  if (undated.length > 0) out.push({ label: UNDATED_LABEL, tasks: undated })
  return out
}

/**
 * The quotas, for the Track panel: every tracked task, in a fixed alphabetical
 * order so logging on one never reorders the others under the user's finger.
 */
export function trackedItems(tasks: Task[]): Task[] {
  return tasks
    .filter((task) => isTracked(task) && !task.done)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
}
