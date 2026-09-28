/**
 * Just-added previews: for 10 minutes after a task is created, a read-only
 * PREVIEW of it sits at the top of the dashboard's Inbox group (or, in a view
 * with no Inbox group, at the top of the list), while the real row stays
 * exactly where it belongs.
 *
 * Why (Trent, 2026-09-27): a task added by quick add, or by an iOS Shortcut
 * POSTing to the API from another device, lands wherever its project, due date
 * and the group's sort put it — often below the fold, or (enriched into
 * another project) somewhere else entirely. Right after adding, the question is
 * "did it land, where, and what did the AI make of it?". The preview answers
 * that in the one place the eye already goes: it shows the task as it now is
 * (title, labels, priority, due, recurrence, the `animate-ai-processing` pulse
 * while enrichment runs), a "New · 3m" badge, and the project when it is not
 * the Inbox. This replaced the separate "Recent" view.
 *
 * The preview is VISUAL ONLY. The real row — at its natural place in its real
 * group — is the task: fully interactive, unfaded, carrying the same "New"
 * badge so it is easy to spot on arrival. The preview has no Done, no swipe,
 * no snooze, no selection, no `task-row-<id>` id; it is outside the keyboard
 * order, shift-click ranges, Select All and every count. Tapping it scrolls to
 * the real row and flashes it (or, when the current view has no row for it —
 * the Today view and a task due next week — opens the task's quick panel).
 *
 * No preview when it would add nothing: a task whose real row is already at
 * the top of the preview's host (the Inbox group, or the list's first group),
 * with only other new tasks above it, is its own preview.
 *
 * Population: the dashboard's unfiltered open tasks (reminders and quotas are
 * not dashboard tasks), NOT the filter-chip result and not the Today view's
 * narrowing — a brand-new task hidden by a filter or by the view is exactly
 * the "did it land?" case. Hidden while searching (the results are the
 * question then).
 *
 * The window is measured from `created_at` (server clock). A
 * `created_at` a moment ahead of this device's clock is still in, and still
 * ages out ten minutes after it. Previews leave without a reload — see
 * `useJustAddedClock`.
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
 * The next moment anything just-added changes on screen: a badge's minute
 * turning over ("New · 2m" → "New · 3m", every whole minute after
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
 * The previews to show above a host's rows.
 *
 * `source` is the population (see the module comment); `hostRows` is the
 * host's real rows in on-screen order — the Inbox group's, or the first
 * group's when the previews sit at the top of the list — or `[]` when the host
 * shows no rows (collapsed, or no such group). A new task whose real row is in
 * the host's leading run of new tasks already sits at the top: previewing it
 * would put a copy directly above itself, so it is left out.
 */
export function selectJustAddedPreviews(source: Task[], hostRows: Task[], now: number): Task[] {
  const atTop = new Set<number>()
  for (const row of hostRows) {
    if (!isJustAdded(row, now)) break
    atTop.add(row.id)
  }
  return selectJustAddedTasks(source, now).filter((t) => !atTop.has(t.id))
}

/**
 * The "New · 3m" badge, on the preview and on the real row. Minutes, floored
 * — inside a 10-minute window nothing coarser is useful. `now` is the
 * dashboard's just-added clock, which advances on each minute boundary
 * (`nextJustAddedTick`), so the badge counts up without polling.
 */
export function formatJustAddedBadge(task: Task, now: number): string {
  const minutes = Math.floor((now - createdMs(task)) / 60_000)
  return minutes < 1 ? 'New · just now' : `New · ${minutes}m`
}
