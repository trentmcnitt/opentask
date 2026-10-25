/**
 * THE DAY ROSTER — a task segment's "N of M" fixed for the day (Trent's phone
 * review, 2026-10-22; docs/TASK-MODEL.md § Task segments).
 *
 * The problem: a segment's M was the rows it held at the moment of reading.
 * Considering a row keeps it (ticked), so N rose; but On deck, Today and done
 * take a row OUT of the segment, so M fell instead — "29 of 44" became "29 of
 * 43" after a deck, and a morning's 75 drifted down all day. Trent: M is
 * everything that came round today, fixed for the day; N is every row handled
 * today — considered, decked, targeted, done or deferred.
 *
 * The rule (one for every panel — the queue's two, Upcoming, the horizons):
 * - Every row a segment lists is remembered for the day (`segment_roster`):
 *   the user's OpenTask day, for every panel ("Day starts at" PR 2, 2026-10-24
 *   — until then the horizons and Upcoming used the calendar day), the day
 *   `queueRowState` and `segmentState` read.
 * - A remembered row that is no longer listed is still counted, as HANDLED, when
 *   the task shows it was handled that day: done (`done_at`, or a repeating
 *   task's `last_completed_at`), targeted or decked from a segment
 *   (`segment_targeted_at` — a deck stamps it too, A7), or considered
 *   (`last_considered_at` — a queued one-off leaves the queue that way). It is
 *   sent as a considered row with `segment_left` saying how it left
 *   ('done' | 'deck' | 'target' | 'considered'), so every client counts it in
 *   N and in M, and lists it behind "Show N considered" — with no put-back:
 *   its way back is the toast's Undo.
 * - A remembered row that left WITHOUT being handled today — trashed, its
 *   Upcoming heads-up over, its horizon changed, its target removed — drops
 *   out of M: it is no longer this segment's.
 * - A listed row always wins: an Undo that puts a decked task back makes it a
 *   waiting row again, never two rows.
 *
 * Upcoming's rows also remember their SECTION (`section`, 2026-10-25, the
 * Upcoming split): a left Upcoming row is sent in the section it was listed
 * in, so each section's own "n of m" stays fixed too. Re-written on every
 * read while the row is listed (a target moved to another section today
 * follows it). NULL — a row remembered before the column, on deploy day —
 * falls back to the section computed now (`fallbackSection`).
 *
 * Known limit: a row handled before any read that day (no surface open) was
 * never remembered, so it is in neither number.
 *
 * Opt-in (`?handled=1`, the web): a native build reads the rows it is sent,
 * and the day simulator and the golden suite pin the segments without it.
 *
 * Bookkeeping, not a task mutation: no undo entry, no activity row and NO
 * sync event — GET /api/reminders is what a sync event makes a client call,
 * so emitting here would loop.
 */

import { getDb } from '@/core/db'
import { openTaskDayOf, openTaskLocalDay } from '@/lib/opentask-day'
import {
  localDay,
  parseDeckDay,
  upcomingState,
  type SegmentKind,
  type SegmentLeft,
  type UpcomingSection,
} from '@/lib/task-segments'
import { rowToTask, taskColumns, type TaskRow } from './read'
import { dayBoundaryForUser } from './rollover-time'
import type { Task } from '@/types'

export type { SegmentLeft }

/** A row that left its segment today, handled: counted, listed as considered. */
export interface LeftRow {
  task: Task
  left: SegmentLeft
  /** Upcoming rows only: the section it was listed in (null on any other segment). */
  section: UpcomingSection | null
}

/** A row a segment lists now: the task, and (Upcoming only) its section. */
export interface ListedRow {
  task: Task
  section: UpcomingSection | null
}

/**
 * Remember today's rows and return, per segment, the remembered rows that
 * left it handled today. `listed`: each segment's rows as placed now.
 */
export function rosterLeftRows(
  userId: number,
  timezone: string,
  now: Date,
  listed: Map<SegmentKind, ListedRow[]>,
): Map<SegmentKind, LeftRow[]> {
  // Every panel runs on the user's OpenTask day (the day start with the
  // task queue on, midnight off).
  const dayStart = dayBoundaryForUser(userId)
  const dayOf = (d: Date) => openTaskDayOf(d, timezone, dayStart)
  const today = dayOf(now)
  const db = getDb()

  db.transaction(() => {
    // A listed row keeps its section current (NULL off Upcoming); `left_how`
    // is never touched here.
    const remember = db.prepare(
      `INSERT INTO segment_roster (user_id, day, kind, task_id, section) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, day, kind, task_id) DO UPDATE SET section = excluded.section
       WHERE section IS NOT excluded.section`,
    )
    for (const [kind, rows] of listed) {
      for (const { task, section } of rows) remember.run(userId, today, kind, task.id, section)
    }
    // Only today's key is ever read: drop the rest.
    db.prepare('DELETE FROM segment_roster WHERE user_id = ? AND day < ?').run(userId, today)
  })()

  const remembered = db
    .prepare(
      'SELECT day, kind, task_id, left_how, section FROM segment_roster WHERE user_id = ? AND day = ?',
    )
    .all(userId, today) as {
    day: string
    kind: SegmentKind
    task_id: number
    left_how: string | null
    section: UpcomingSection | null
  }[]
  const missing = remembered.filter(
    (r) => !(listed.get(r.kind) ?? []).some((t) => t.task.id === r.task_id),
  )
  const out = new Map<SegmentKind, LeftRow[]>()
  if (missing.length === 0) return out

  const ids = [...new Set(missing.map((r) => r.task_id))]
  const tasks = new Map(
    (
      db
        .prepare(
          `SELECT ${taskColumns()} FROM tasks
           WHERE id IN (${ids.map(() => '?').join(', ')}) AND user_id = ?
             AND deleted_at IS NULL`,
        )
        .all(...ids, userId) as TaskRow[]
    ).map((row) => {
      const task = rowToTask(row)
      return [task.id, task] as const
    }),
  )
  for (const r of missing) {
    const task = tasks.get(r.task_id)
    // Trashed: gone from M. (Not `archived_at`: done archives a one-off.)
    if (!task) continue
    const left = howItLeft(
      task,
      (iso) => iso !== null && dayOf(new Date(iso)) === today,
      r.left_how,
    )
    if (!left) continue
    const section =
      r.kind === 'upcoming' ? (r.section ?? fallbackSection(task, timezone, now, dayStart)) : null
    const list = out.get(r.kind) ?? []
    list.push({ task, left, section })
    out.set(r.kind, list)
  }
  return out
}

/**
 * A left Upcoming row with no remembered section (remembered before the
 * column, deploy day): the section it would be in now, if it still has one
 * (`upcomingState`, read as unconsidered); else the rule's own test — Tomorrow
 * when its anchor (deck day, else target) is tomorrow, otherwise Later. A done
 * or targeted-today row usually has no anchor ahead: Later.
 */
function fallbackSection(
  task: Task,
  timezone: string,
  now: Date,
  dayStart: string,
): UpcomingSection {
  const fresh = { ...task, last_considered_at: null, segment_deferred_at: null }
  const placed = upcomingState(fresh, timezone, now, dayStart)
  if (placed) return placed.section
  const tomorrow = openTaskLocalDay(now, timezone, dayStart).plus({ days: 1 })
  const anchor = task.on_deck_day
    ? parseDeckDay(task.on_deck_day, timezone)
    : task.due_at
      ? localDay(task.due_at, timezone, dayStart)
      : null
  return anchor && +anchor === +tomorrow ? 'tomorrow' : 'later'
}

/**
 * The deadlines page's Defer (`deferLeads`, 2026-10-22) marks the row it moved
 * off the page as left DEFERRED for the OpenTask day, in the same write — so
 * only an actual defer reads "· deferred to Thu", never a deadline change.
 * Bookkeeping, like the roster itself: no undo entry (an undone defer puts the
 * row back on the page, and a listed row always wins).
 */
export function markRosterDeferred(userId: number, day: string, taskIds: number[]): void {
  const stmt = getDb().prepare(
    `INSERT INTO segment_roster (user_id, day, kind, task_id, left_how)
     VALUES (?, ?, 'deadlines', ?, 'deferred')
     ON CONFLICT (user_id, day, kind, task_id) DO UPDATE SET left_how = 'deferred'`,
  )
  for (const id of taskIds) stmt.run(userId, day, id)
}

/** How the task was handled on the segment's day, or null when it was not. */
function howItLeft(
  task: Task,
  onDay: (iso: string | null) => boolean,
  leftHow: string | null = null,
): SegmentLeft | null {
  // `last_completed_at` for a repeating task only: an undone one-off keeps it.
  if (
    (task.done && onDay(task.done_at)) ||
    (task.rrule !== null && onDay(task.last_completed_at))
  ) {
    return 'done'
  }
  if (onDay(task.segment_targeted_at)) return task.on_deck_day ? 'deck' : 'target'
  // The deadlines page (2026-10-22): a Defer of the lead day, as the endpoint
  // marked it (`markRosterDeferred`) — acting, so handled (nag-map ruling 3).
  if (leftHow === 'deferred') return 'deferred'
  if (onDay(task.last_considered_at)) return 'considered'
  return null
}
