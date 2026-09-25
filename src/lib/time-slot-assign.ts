/**
 * Time-slot assignment — the pure half (REDESIGN-V03 §6.0)
 *
 * Separated from `@/core/time-slots` because that module imports `getDb`, and
 * the dashboard needs to group by slot on the CLIENT. Importing the core module
 * from a component would drag better-sqlite3 into the browser bundle.
 *
 * NAMING GUARD: this is a **time slot**, never a "bucket" — `bucket` already
 * names the due-date classifier in useFilterState.ts / DueDateFilterBar.tsx.
 */

import { DateTime } from 'luxon'

export interface TimeSlot {
  id: number
  user_id: number
  label: string
  /** HH:MM local */
  start_time: string
  sort_order: number
  created_at: string
}

/** Seeded from the production clusters measured at spec time (§6.0). */
export const DEFAULT_TIME_SLOTS: ReadonlyArray<{ label: string; start_time: string }> = [
  { label: 'Early morning', start_time: '07:00' },
  { label: 'Morning', start_time: '09:00' },
  { label: 'Midday', start_time: '12:00' },
  { label: 'Afternoon', start_time: '16:00' },
  { label: 'Evening', start_time: '20:30' },
]

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

export function parseHHMM(value: string): number | null {
  const match = HHMM.exec(value)
  if (!match) return null
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10)
}

/**
 * The item shape slot assignment needs.
 *
 * `anchor_time` wins over `due_at` because for a recurring item it is the
 * *intended* time of day, and §4.6 establishes that a recurring item's `due_at`
 * cannot be trusted — it only stays fresh while the user keeps sweeping.
 */
export interface SlottableItem {
  anchor_time: string | null
  due_at: string | null
}

/**
 * Resolve an item's local time of day in minutes, or null if it has none.
 *
 * `anchor_time` is already local HH:MM. `due_at` is UTC and must be converted
 * through the user's timezone — reading its UTC hour directly would put a 07:00
 * Chicago task in the afternoon slot.
 */
export function itemTimeOfDayMinutes(item: SlottableItem, timezone: string): number | null {
  if (item.anchor_time) {
    const parsed = parseHHMM(item.anchor_time)
    if (parsed !== null) return parsed
  }
  if (!item.due_at) return null

  const local = DateTime.fromISO(item.due_at, { zone: 'utc' }).setZone(timezone)
  if (!local.isValid) return null
  return local.hour * 60 + local.minute
}

/**
 * Assign an item to a slot.
 *
 * §6.0's rule: the slot with the latest `start_time` less than or equal to the
 * item's time of day. An item earlier than every slot boundary, or with no time
 * of day at all, gets null — those render in the un-slotted group ("Anytime
 * today", §7.3) rather than being silently dropped from the front door.
 */
export function assignSlot(
  item: SlottableItem,
  slots: TimeSlot[],
  timezone: string,
): TimeSlot | null {
  const minutes = itemTimeOfDayMinutes(item, timezone)
  if (minutes === null) return null

  let best: TimeSlot | null = null
  let bestStart = -1
  for (const slot of slots) {
    const start = parseHHMM(slot.start_time)
    if (start === null || start > minutes) continue
    if (start > bestStart) {
      bestStart = start
      best = slot
    }
  }
  return best
}

/**
 * The slot whose start time is closest to `minutes`, earlier or later. On a
 * tie the slot listed first wins, so callers pass slots earliest-first to make
 * a tie go to the earlier slot.
 *
 * Two users: the reminder enrichment guard (a stated 7pm snaps to an 8:30pm
 * Evening rather than rounding down into Afternoon) and deleting a slot, whose
 * reminders go to the nearest remaining one (`src/core/time-slots/edit.ts`).
 */
export function nearestSlot<T extends Pick<TimeSlot, 'start_time'>>(
  minutes: number,
  slots: T[],
): T | null {
  let best: T | null = null
  let bestDistance = Infinity
  for (const slot of slots) {
    const start = parseHHMM(slot.start_time)
    if (start === null) continue
    const distance = Math.abs(start - minutes)
    if (distance < bestDistance) {
      bestDistance = distance
      best = slot
    }
  }
  return best
}

/**
 * Group items into slots, in slot order, with the un-slotted items last.
 *
 * Empty slots are retained: a slot the user defined is part of how they read
 * their day, and silently omitting it makes the view's shape change based on
 * data rather than on their configuration.
 */
export function groupBySlot<T extends SlottableItem>(
  items: T[],
  slots: TimeSlot[],
  timezone: string,
): { slot: TimeSlot | null; items: T[] }[] {
  const ordered = [...slots].sort(
    (a, b) => (parseHHMM(a.start_time) ?? 0) - (parseHHMM(b.start_time) ?? 0),
  )
  const groups = new Map<number | null, T[]>()
  for (const slot of ordered) groups.set(slot.id, [])
  groups.set(null, [])

  for (const item of items) {
    const slot = assignSlot(item, ordered, timezone)
    groups.get(slot?.id ?? null)!.push(item)
  }

  const result: { slot: TimeSlot | null; items: T[] }[] = ordered.map((slot) => ({
    slot,
    items: groups.get(slot.id)!,
  }))
  result.push({ slot: null, items: groups.get(null)! })
  return result
}

/**
 * The slot the day is "in" right now: the slot with the latest `start_time`
 * at or before the current local time. Before the first slot starts there is
 * no current slot (null) — the day hasn't reached its first moment yet.
 *
 * Used by the Reminders surface to decide which slot opens by default: the
 * user asked for the screen to read as "a handful", and the current slot is
 * the only one whose thoughts are timely. Everything else stays one tap away.
 */
export function currentSlot(
  slots: TimeSlot[],
  timezone: string,
  now: Date = new Date(),
): TimeSlot | null {
  const local = DateTime.fromJSDate(now).setZone(timezone)
  const minutes = local.hour * 60 + local.minute
  let best: TimeSlot | null = null
  let bestStart = -1
  for (const slot of slots) {
    const start = parseHHMM(slot.start_time)
    if (start === null || start > minutes) continue
    if (start > bestStart) {
      bestStart = start
      best = slot
    }
  }
  return best
}

/** A group of items sitting in a slot (or the un-slotted bucket) — the minimal
 * shape `naturalSlotIndex` needs, so it works on `ReminderGroup[]` (the
 * Reminders hook's shape) without this module importing that type. */
export interface SlotIndexed {
  slot: TimeSlot | null
}

/**
 * Which GROUP the day is naturally "in" right now, as an index into `groups`
 * (in the order the caller already has them — the un-slotted bucket last, as
 * `groupBySlot` always puts it).
 *
 * Mirrors `RemindersTimeline.naturalSlotIndex` in
 * `ios/OpenTaskWidgets/RemindersWidget.swift` exactly, so the dashboard's
 * Reminders panel opens on the same slot the widget would: the latest slot
 * whose `start_time` is at or before the current local time, else the FIRST
 * slotted group (never the trailing un-slotted one) if the day hasn't reached
 * its first boundary yet — "here's what's coming" reads better at 5am than an
 * empty un-slotted pile. `currentSlot` above answers a narrower question (is
 * there a TimeSlot the clock is in right now) and returns null before the
 * first boundary; this always resolves to an index because a pager has to
 * land on something.
 */
export function naturalSlotIndex(
  groups: SlotIndexed[],
  timezone: string,
  now: Date = new Date(),
): number {
  if (groups.length === 0) return 0

  const local = DateTime.fromJSDate(now).setZone(timezone)
  const minutes = local.hour * 60 + local.minute

  let best = -1
  let bestStart = -1
  groups.forEach((group, index) => {
    const start = group.slot ? parseHHMM(group.slot.start_time) : null
    if (start === null || start > minutes) return
    if (start > bestStart) {
      bestStart = start
      best = index
    }
  })
  if (best >= 0) return best

  const firstSlotted = groups.findIndex((g) => g.slot !== null)
  return firstSlotted >= 0 ? firstSlotted : 0
}

/**
 * The next time a slot starts: today, if its start is still ahead of `now`
 * in `timezone`, otherwise tomorrow. As a UTC ISO string, the form every
 * snooze target takes.
 *
 * What a snooze "to a period" means (Trent, 2026-09-22): "Early morning" at
 * 9pm is tomorrow at 7:00, "Evening" at 9am is tonight at 8:30. A start equal
 * to `now` counts as passed — snoozing to the minute you are already in would
 * be a snooze to nothing.
 */
export function nextSlotStart(startTime: string, timezone: string, now: Date = new Date()): string {
  const minutes = parseHHMM(startTime)
  if (minutes === null) throw new Error(`Not an HH:MM start time: ${startTime}`)
  const local = DateTime.fromJSDate(now).setZone(timezone)
  const today = local.set({
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
    second: 0,
    millisecond: 0,
  })
  return (today > local ? today : today.plus({ days: 1 })).toUTC().toISO()!
}

/**
 * The next period's start: the first slot that starts after `now` today, or
 * the day's first slot tomorrow once the last one has begun. Null with no
 * slots. Backs the notification's "All → Next period" — Midday from the
 * morning, Afternoon from Midday, tomorrow's Early morning from the evening.
 */
export function nextPeriodStart(
  slots: Pick<TimeSlot, 'start_time'>[],
  timezone: string,
  now: Date = new Date(),
): string | null {
  const starts = slots.map((s) => nextSlotStart(s.start_time, timezone, now)).sort()
  return starts[0] ?? null
}

/**
 * Where the Reminders pager goes when the slot on screen has just been
 * finished — its last reminder considered — or null to stay put.
 *
 * THE EARLIEST UNDONE SLOT (Trent, 2026-09-23, refining 2026-09-22's rule):
 * "When you complete everything for the morning, let's say it's midday, it
 * should take you to the earliest undone tab next. Once I finish morning, it
 * should take me automatically back to early morning… so I can keep checking
 * things off." The first version only ever moved FORWARD from a past slot, so
 * finishing the slot the day was in left him there — pleased with himself,
 * with early morning still waiting unseen.
 *
 * So: the first slot of the day, up to and including the natural one, that
 * still has something waiting — whether the finished slot was earlier than
 * now or the current one. Never a slot after the natural one: one that has not
 * started is not undone, it is not yet due. Nothing waiting anywhere up to
 * now: a finished past slot goes to the natural one (where the pager opens
 * anyway); a finished current slot stays, and says it is done.
 */
export function slotAfterFinishing(
  groups: { reminders: unknown[] }[],
  finished: number,
  natural: number,
): number | null {
  for (let i = 0; i <= natural && i < groups.length; i++) {
    if (i !== finished && groups[i].reminders.length > 0) return i
  }
  return finished < natural ? natural : null
}
