/**
 * Just added: for 10 minutes after a task is created it is listed in the
 * dashboard's "Just added" card, under the add field (`JustAddedCard`), while
 * its real row stays exactly where it belongs and wears a small "New" tag.
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
 * History: #115 was a separate "Recent" view; #121 replaced it with a dashed
 * read-only copy of the row at the top of the Inbox, which Trent found cheap-
 * looking next to the real row; the card (mockup A of three, 2026-09-28)
 * replaced that.
 *
 * Population: the dashboard's unfiltered open tasks (reminders and quotas are
 * not dashboard tasks), NOT the filter-chip result and not the Today view's
 * narrowing — a brand-new task hidden by a filter or by the view is exactly
 * the "did it land?" case. Hidden while searching (the results are the
 * question then).
 *
 * The window is measured from `created_at` (server clock). A `created_at` a
 * moment ahead of this device's clock is still in, and still ages out ten
 * minutes after it. Entries leave without a reload — see `useJustAddedClock`.
 */
import type { Task } from '@/types'

export const JUST_ADDED_WINDOW_MINUTES = 10
export const JUST_ADDED_WINDOW_MS = JUST_ADDED_WINDOW_MINUTES * 60 * 1000

function createdMs(task: Task): number {
  return Date.parse(task.created_at)
}

/** True while the task is inside the 10-minute window. Exactly 10 minutes old is out. */
export function isJustAdded(task: Task, now: number): boolean {
  const created = createdMs(task)
  return !Number.isNaN(created) && created > now - JUST_ADDED_WINDOW_MS
}

/**
 * Tasks inside the window, newest first. Ties (two adds in the same instant, or
 * rows written with the schema's whole-second default) break by id, higher
 * first, since ids are assigned in insert order.
 */
export function selectJustAddedTasks(tasks: Task[], now: number): Task[] {
  return tasks
    .filter((t) => isJustAdded(t, now))
    .sort((a, b) => createdMs(b) - createdMs(a) || b.id - a.id)
}

/**
 * The moment (epoch ms) the next task in the window ages out of it, or null
 * when none is in the window. The last of `nextJustAddedTick`'s ticks for a
 * task is this moment; the dashboard schedules on the ticks.
 */
export function nextJustAddedExpiry(tasks: Task[], now: number): number | null {
  let next: number | null = null
  for (const t of tasks) {
    const created = createdMs(t)
    if (Number.isNaN(created)) continue
    const expiry = created + JUST_ADDED_WINDOW_MS
    if (expiry > now && (next === null || expiry < next)) next = expiry
  }
  return next
}

/**
 * The next moment anything just-added changes on screen: an entry's age
 * turning over ("2m ago" → "3m ago", every whole minute after
 * `created_at`) or, at the tenth, the task aging out. Null when nothing is in
 * the window. `useJustAddedClock` schedules ONE timeout for this — the next
 * visible change — rather than ticking on an interval.
 */
export function nextJustAddedTick(tasks: Task[], now: number): number | null {
  let next: number | null = null
  for (const t of tasks) {
    const created = createdMs(t)
    if (Number.isNaN(created) || created + JUST_ADDED_WINDOW_MS <= now) continue
    // The first whole minute after `created_at` that is still ahead of now.
    const minutes = Math.max(1, Math.floor((now - created) / 60_000) + 1)
    const tick = created + minutes * 60_000
    if (next === null || tick < next) next = tick
  }
  return next
}

/**
 * How long ago, for the Just added card: "just now" under a minute, then
 * "2m ago". Minutes, floored — inside a 10-minute window nothing coarser is
 * useful. `now` is the dashboard's just-added clock, which advances on each
 * minute boundary (`nextJustAddedTick`), so the age counts up without polling.
 */
export function formatJustAddedAge(task: Task, now: number): string {
  const minutes = Math.floor((now - createdMs(task)) / 60_000)
  return minutes < 1 ? 'just now' : `${minutes}m ago`
}
