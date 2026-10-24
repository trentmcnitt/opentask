/**
 * Just now: for 15 minutes after a task is created — or targeted from a task
 * segment — it is listed in the dashboard's "Just now" card, under the add
 * field (`JustAddedCard`), while its real row stays exactly where it belongs
 * and wears a small tag ("New", or "Targeted").
 *
 * Why (Trent, 2026-09-27, restated 2026-09-28): a task added by quick add, by
 * the Mac menu bar, or by an iOS Shortcut POSTing to the API from another
 * device, lands wherever its project, due date and the group's sort put it —
 * often below the fold, or (enriched into another project) somewhere else
 * entirely. Right after adding, the question is "did it land, where, and what
 * did the AI make of it?", and it must be answerable without scrolling and
 * without moving the real row: "We have to have a place that shows the recent
 * tasks without having to scroll down", and "the real row at the top means
 * it's not in the actual place it's supposed to be". The card shows each
 * task's project, what the AI filled in (or that it is still working) and how
 * long ago it was added; a tap scrolls to the real row and flashes it (or,
 * when the current view has no row for it, opens the task).
 *
 * TARGETED TOO (Trent, 2026-10-12). Many tasks get their target with one tap
 * of the Today button on a task-segment row (or a time from its long-press
 * picker), and right after, he wants to see them and re-target the odd one —
 * same card, same 15 minutes, each entry saying which happened ("Added 2m
 * ago" / "Targeted 2m ago"). The targeted event is `segment_targeted_at`,
 * which ONLY that segment action stamps — an ordinary snooze or edit never
 * does, or every snooze would flood the card. The card was "Just added"
 * until then; with two kinds of entry it is "Just now".
 *
 * ONE ENTRY PER TASK, under its LATEST event: a task added and then targeted
 * inside the window is listed once, as targeted, timed from the targeting.
 * The window, the order, the age text and the clock's ticks all read that
 * latest event, and "Clear" hides an entry by id AND event time — a task
 * re-targeted after a Clear has a new event, so it shows again.
 *
 * History: #115 was a separate "Recent" view; #121 replaced it with a dashed
 * read-only copy of the row at the top of the Inbox, which Trent found cheap-
 * looking next to the real row; the card (mockup A of three, 2026-09-28)
 * replaced that.
 *
 * Population: the dashboard's unfiltered open tasks (reminders and quotas are
 * not dashboard tasks), NOT the filter-chip result and not Now's folds — a
 * brand-new task hidden by a filter or behind a project's "+ N more" is
 * exactly the "did it land?" case. Hidden while searching (the results are the
 * question then).
 *
 * Event times are server clock. One a moment ahead of this device's clock is
 * still in, and still ages out fifteen minutes after it. Entries leave without
 * a reload — see `useJustAddedClock`.
 */
import { openTaskLocalDay } from '@/lib/opentask-day'
import { parseDeckDay } from '@/lib/task-segments'
import type { Task } from '@/types'

/** 10 until 2026-10-12, when Trent widened it. The enrichment-success push
 *  (`enrichment-notify.ts`) shares this window, so it widened with it. */
export const JUST_ADDED_WINDOW_MINUTES = 15
export const JUST_ADDED_WINDOW_MS = JUST_ADDED_WINDOW_MINUTES * 60 * 1000

/** Which event put the task in the card. */
export type JustAddedKind = 'added' | 'targeted' | 'decked'

export interface JustAddedEvent {
  kind: JustAddedKind
  /** Epoch ms of the event (server clock). */
  at: number
}

/** A card entry: the task under its latest event. */
export interface JustAddedEntry extends JustAddedEvent {
  task: Task
}

/**
 * The task's latest event — created, or targeted from a task segment —
 * whether or not it is still inside the window. Null when neither time parses.
 * A tie (targeted in the same instant it was created) reads as added.
 */
function latestEvent(task: Task): JustAddedEvent | null {
  const created = Date.parse(task.created_at)
  const targeted = task.segment_targeted_at ? Date.parse(task.segment_targeted_at) : NaN
  if (!Number.isNaN(targeted) && (Number.isNaN(created) || targeted > created)) {
    // On deck (D2): a deck stamps the same moment Today does (A7), and the
    // task still on deck says that is what it was — "On deck", not "Targeted".
    return { kind: task.on_deck_day ? 'decked' : 'targeted', at: targeted }
  }
  return Number.isNaN(created) ? null : { kind: 'added', at: created }
}

/**
 * The event that puts the task in the card right now, or null when its latest
 * event is 15 minutes old or more (exactly 15 minutes is out). Only the LATEST
 * event counts: once it ages out, an older one is older still.
 */
export function justAddedEvent(task: Task, now: number): JustAddedEvent | null {
  const event = latestEvent(task)
  return event && event.at > now - JUST_ADDED_WINDOW_MS ? event : null
}

/** True while the task is in the card (added or targeted inside the window). */
export function isJustAdded(task: Task, now: number): boolean {
  return justAddedEvent(task, now) !== null
}

/**
 * The card's entries, newest event first. Ties (two adds in the same instant,
 * or rows written with the schema's whole-second default) break by id, higher
 * first, since ids are assigned in insert order.
 */
export function selectJustAddedEntries(tasks: Task[], now: number): JustAddedEntry[] {
  const entries: JustAddedEntry[] = []
  for (const task of tasks) {
    const event = justAddedEvent(task, now)
    if (event) entries.push({ task, ...event })
  }
  return entries.sort((a, b) => b.at - a.at || b.task.id - a.task.id)
}

/**
 * A DECK UPDATE (Trent, 2026-10-22, phone review): an entry whose only news is
 * that the task went on deck — listed under its deck, for a task created
 * before the window. Decking is done in runs (a queue panel's rows, one tap
 * each), and each one used to take a full entry, pushing what was actually
 * added off the card. The card folds these behind "Show N on deck updates".
 * A task created AND decked inside the window is not one: it is new, and a
 * new task must never be folded away ("did it land?" is the card's question).
 *
 * Taking a task off deck stamps nothing (`collectDeckChange` clears the deck's
 * Just now stamp), so there is no "deck removed" entry to fold.
 */
export function isDeckUpdate(entry: JustAddedEntry): boolean {
  if (entry.kind !== 'decked') return false
  const created = Date.parse(entry.task.created_at)
  // Against the deck's own moment, not now, so an entry never moves behind
  // the fold while it is listed.
  return Number.isNaN(created) || created <= entry.at - JUST_ADDED_WINDOW_MS
}

/** What "Clear" remembers an entry by: a new event for the same task is a new key. */
export function justAddedEntryKey(entry: { task: Task; at: number }): string {
  return `${entry.task.id}:${entry.at}`
}

/**
 * The moment (epoch ms) the next task in the window ages out of it, or null
 * when none is in the window. The last of `nextJustAddedTick`'s ticks for a
 * task is this moment; the dashboard schedules on the ticks.
 */
export function nextJustAddedExpiry(tasks: Task[], now: number): number | null {
  let next: number | null = null
  for (const t of tasks) {
    const event = latestEvent(t)
    if (!event) continue
    const expiry = event.at + JUST_ADDED_WINDOW_MS
    if (expiry > now && (next === null || expiry < next)) next = expiry
  }
  return next
}

/**
 * The next moment anything in the card changes on screen: an entry's age
 * turning over ("2m ago" → "3m ago", every whole minute after its latest
 * event) or, at the fifteenth, the task aging out. Null when nothing is in
 * the window. `useJustAddedClock` schedules ONE timeout for this — the next
 * visible change — rather than ticking on an interval.
 */
export function nextJustAddedTick(tasks: Task[], now: number): number | null {
  let next: number | null = null
  for (const t of tasks) {
    const event = latestEvent(t)
    if (!event || event.at + JUST_ADDED_WINDOW_MS <= now) continue
    // The first whole minute after the event that is still ahead of now.
    const minutes = Math.max(1, Math.floor((now - event.at) / 60_000) + 1)
    const tick = event.at + minutes * 60_000
    if (next === null || tick < next) next = tick
  }
  return next
}

/**
 * How long ago the task's latest event was: "just now" under a minute, then
 * "2m ago". Minutes, floored — inside a 15-minute window nothing coarser is
 * useful. `now` is the dashboard's just-added clock, which advances on each
 * minute boundary (`nextJustAddedTick`), so the age counts up without polling.
 */
export function formatJustAddedAge(task: Task, now: number): string {
  const event = latestEvent(task)
  const minutes = event ? Math.floor((now - event.at) / 60_000) : 0
  return minutes < 1 ? 'just now' : `${minutes}m ago`
}

/** The entry's age line: "Added 2m ago", "Targeted just now", "On deck 3m ago". */
export function formatJustAddedLabel(entry: JustAddedEntry, now: number): string {
  const verb = { targeted: 'Targeted', decked: 'On deck', added: 'Added' }[entry.kind]
  return `${verb} ${formatJustAddedAge(entry.task, now)}`
}

/**
 * The tag on the task's real row: "New" for an add, "Targeted" for a
 * targeting, and for a deck its day — "On deck" today, "On deck tomorrow",
 * else "On deck Nov 15" (`deckTagLabel`).
 */
export function justAddedTag(
  task: Task,
  now: number,
  timezone: string | undefined,
  dayStart: string,
): string | undefined {
  const event = justAddedEvent(task, now)
  if (!event) return undefined
  if (event.kind === 'decked') return deckTagLabel(task.on_deck_day, timezone, now, dayStart)
  return { targeted: 'Targeted', added: 'New' }[event.kind]
}

/**
 * A deck's tag on a dashboard row (Trent's phone review, 2026-10-22: a row
 * decked for a later day read just "On deck", as if it were today's). Today's
 * deck stays "On deck" — Now's On deck section and the filled button already
 * say which day; tomorrow is "On deck tomorrow", the segment row's own button
 * name; a later day is "On deck Nov 15" — the dashboard rows' date chips'
 * format ("Nov 1 9:00 AM": month and day, no weekday). The date is shown
 * rather than the tag dropped: the tag is the row's "it landed" mark.
 * Without a zone (or with a day that does not parse) it says "On deck".
 */
export function deckTagLabel(
  day: string | null | undefined,
  timezone: string | undefined,
  now: number,
  /** The user's day boundary (`useDayStart`): "tomorrow" is the next OpenTask day. */
  dayStart: string,
): string {
  if (!day || !timezone) return 'On deck'
  const deck = parseDeckDay(day, timezone)
  if (!deck) return 'On deck'
  const today = openTaskLocalDay(new Date(now), timezone, dayStart)
  if (deck <= today) return 'On deck'
  if (+deck === +today.plus({ days: 1 })) return 'On deck tomorrow'
  return `On deck ${deck.toFormat('LLL d')}`
}
