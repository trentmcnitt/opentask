/**
 * Task response formatting helper
 *
 * Adds computed fields (is_recurring, target_at) to task responses.
 * Also provides clipboard formatting for selected tasks.
 */

import type { Task } from '@/types'
import type { SortOption } from '@/lib/task-grouping'
import { formatDueTimeParts } from '@/lib/format-date'
import { formatRRule, withRepeatEnd } from '@/lib/format-rrule'
import { getPriorityOption } from '@/lib/priority'
import { ageLabel, attemptsLabel, attemptsOffer, repeatRemaining } from '@/lib/task-segments'
import { taskQueueEnabled } from '@/core/tasks/task-queue'

export interface ClipboardGroup {
  label: string
  tasks: Task[]
  sort: SortOption
  reversed: boolean
}

const CLIPBOARD_SORT_LABELS: Record<SortOption, { default: string; reversed: string }> = {
  due_date: { default: 'Soonest First', reversed: 'Latest First' },
  priority: { default: 'Highest Priority', reversed: 'Lowest Priority' },
  title: { default: 'A-Z', reversed: 'Z-A' },
  age: { default: 'Newest First', reversed: 'Oldest First' },
  modified: { default: 'Recently Modified', reversed: 'Least Recently Modified' },
  original_due: { default: 'Oldest Original Due', reversed: 'Newest Original Due' },
  horizon: { default: 'Horizon, then deadline', reversed: 'Horizon, reversed' },
  ai_insights: { default: 'AI Score ↓', reversed: 'AI Score ↑' },
}

export interface FormattedTask extends Task {
  is_recurring: boolean
  /**
   * REPEAT ENDS (2026-10-22, `isLastOccurrence`): closing the current
   * occurrence ends the series. False with no end, and on a closed row.
   */
  repeat_last: boolean
  /** `repeat_count − repeat_count_used` (the current one included); null with no count. */
  repeat_remaining: number | null
  /**
   * The TARGET (2026-10-10): when nagging starts. The primary name; `due_at`
   * is the same value under its deprecated name, kept for older clients.
   */
  target_at: string | null
  /**
   * RETIRED (2026-10-12, §8): no longer stored; a compatibility signal for
   * shipped native builds, which decode it (`TaskDTO.deadlineNagOff`) and
   * still run their own implied-target rule (`TargetAge.swift`). See
   * `nativeNagOff`.
   */
  deadline_nag_off: boolean
  /**
   * THE TWO BADGES (spec §7, 2026-10-12), server-computed so the native apps
   * draw the server's answer and copy no rule:
   * - `attempts_label`: "3×" — the task's attempts (local days over target,
   *   `attempts`), shown only while it has a target and at least one attempt;
   *   else null.
   * - `attempts_offer`: at 3× (`ATTEMPTS_OFFER_REMOVE`), what the row offers —
   *   "remove" (Remove target?), or null (none yet, an automatic target, a
   *   repeating task, or — task queue on — a strippable one-off, whose
   *   target the rollover takes off on its own). "auto" (Back to auto?) is
   *   no longer sent (2026-10-22, the deadlines page: a deadline task's
   *   target is removed like any other); it stays in the type for builds
   *   that decode it.
   *   The web row computes the same answer live (TaskRow: `attemptsOffer`
   *   with the switch from GET /api/user/preferences), so it never waits for
   *   a refetch.
   * - `age_label`: ">1 wk" / ">1 mo" / ">3 mo" / ">6 mo" on a task with
   *   neither a target nor a deadline, past its horizon's threshold; else null.
   *   Calendar math in the user's timezone, as the web row computes it.
   */
  attempts_label: string | null
  attempts_offer: 'remove' | 'auto' | null
  age_label: string | null
}

/**
 * What shipped native builds must read as `deadline_nag_off` so that their
 * implied-target rule (`TargetAge.impliedTarget`) returns nothing and they
 * read `due_at` as the target — the server's own answer:
 *
 * - false for nearly every task: a deadline task's stored target is at or
 *   before its deadline, which their rule honors as set;
 * - TRUE for a one-off with a deadline and NO target (the deadlines page,
 *   2026-10-22): their rule would invent one;
 * - TRUE for a one-off whose deadline has PASSED and whose target is after it
 *   (Trent's ruling, 2026-10-12: once the deadline has passed any target can
 *   be picked). Their rule implies a target 4 days before the deadline for a
 *   target past it — over target at once — unless the nag is off and the
 *   deadline has passed, in which case it leaves the task to its own target.
 */
function nativeNagOff(task: Task, now: Date): boolean {
  if (task.rrule !== null || task.deadline_at === null) return false
  // THE DEADLINES PAGE (2026-10-22, plan L5): a one-off with a deadline and NO
  // target. Builds installed 10-10..10-12 imply a target 4 days before the
  // deadline whenever `due_at` is nil and the nag is not off
  // (`TargetAge.impliedTargetDate`, fe6e8daf), and would show such a task
  // overdue at once. The nag-off flag turns their rule off.
  if (task.due_at === null) return true
  const deadline = Date.parse(task.deadline_at)
  return deadline <= now.getTime() && Date.parse(task.due_at) > deadline
}

/**
 * Format a task for API response by adding computed fields. `is_snoozed` and
 * `snooze_count` left the response on 2026-10-12 (§6: no snooze state); no
 * native build decodes either.
 *
 * `timezone` is the user's (the reader's — a route passes `user.timezone`; a
 * webhook or export, the owner's): `age_label` is calendar math in it, exactly
 * as the web row computes it (`ageLabel(task, now, timezone)` in TaskRow), so
 * a "month" ends at the same local moment on every client.
 */
export function formatTaskResponse(task: Task, timezone: string): FormattedTask {
  const now = new Date()
  return {
    ...task,
    target_at: task.due_at,
    is_recurring: task.rrule !== null,
    // 2026-10-21: null on a one-off — it has no rule for the anchor to describe.
    repeat_anchor: task.rrule !== null ? task.repeat_anchor : null,
    // Repeat ends (2026-10-22): `rowToTask` derives them in the owner's zone
    // and day (`isLastOccurrence` needs the owner's day start since
    // from-completion repeats count OpenTask days, 2026-10-26), on every row
    // with an end — every server read selects `taskColumns`. A task without
    // it has no end to judge (the export's rows select none): not the last.
    repeat_last: task.repeat_last ?? false,
    repeat_remaining: task.repeat_remaining ?? repeatRemaining(task),
    deadline_nag_off: nativeNagOff(task, now),
    attempts_label: attemptsLabel(task),
    // Task queue on: no "Remove target?" on a strippable task (resolution 1).
    attempts_offer: attemptsOffer(task, now, { queue: taskQueueEnabled() }),
    age_label: ageLabel(task, now, timezone),
  }
}

/**
 * Format multiple tasks for API response
 */
export function formatTasksResponse(tasks: Task[], timezone: string): FormattedTask[] {
  return tasks.map((task) => formatTaskResponse(task, timezone))
}

/**
 * Build the parenthetical metadata string for a single task.
 * Order: project name (in brackets), then parenthetical with due date, recurrence, priority, labels.
 * Empty parts are omitted. Returns empty string if no metadata is present.
 */
function formatTaskMeta(
  task: Task,
  timezone: string,
  dayStart: string,
  projectName?: string,
): string {
  const prefix = projectName ? ` [${projectName}]` : ''
  const parts: string[] = []

  if (task.due_at) {
    parts.push(formatDueTimeParts(task.due_at, timezone, dayStart).relative)
  }

  if (task.rrule) {
    parts.push(withRepeatEnd(formatRRule(task.rrule, task.anchor_time), task))
  }

  if (task.priority > 0) {
    parts.push(getPriorityOption(task.priority).label)
  }

  if (task.labels.length > 0) {
    parts.push(...task.labels)
  }

  const parens = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `${prefix}${parens}`
}

/**
 * Format the first line of task notes for clipboard, truncated to ~100 chars.
 * Returns null if notes is empty/null.
 */
function formatNotesLine(notes: string | null): string | null {
  if (!notes) return null
  const firstLine = notes.split('\n')[0].trim()
  if (!firstLine) return null
  if (firstLine.length > 100) return firstLine.slice(0, 97) + '...'
  return firstLine
}

/**
 * Format selected tasks as human-readable clipboard text, grouped to match the screen.
 *
 * Output rules:
 * - Groups match the current screen grouping (time buckets or projects)
 * - Each header includes the active sort annotation, e.g. "Today (Soonest First):"
 * - Empty groups are skipped
 * - Single task in a group: no bullet prefix
 * - Multiple tasks in a group: bullet prefix ("- ") for each task
 * - Multiple groups: separated by blank lines
 * - Metadata (due, recurrence, priority, labels) in parentheses after title
 */
export function formatTasksForClipboard(
  groups: ClipboardGroup[],
  timezone: string,
  /** The user's day boundary (`useDayStart`): "Tomorrow 9:00 AM" by OpenTask day. */
  dayStart: string,
  projectMap?: Map<number, string>,
  annotationMap?: Map<number, string>,
): string {
  const sections: string[] = []

  for (const group of groups) {
    if (group.tasks.length === 0) continue

    const sortLabel = CLIPBOARD_SORT_LABELS[group.sort]
    const annotation = group.reversed ? sortLabel.reversed : sortLabel.default
    const lines: string[] = [`${group.label} (${annotation}):`]

    const bullet = group.tasks.length > 1 ? '- ' : ''
    for (const task of group.tasks) {
      const projectName = projectMap?.get(task.project_id)
      lines.push(`${bullet}${task.title}${formatTaskMeta(task, timezone, dayStart, projectName)}`)
      const annotation = annotationMap?.get(task.id)
      if (annotation) {
        lines.push(`    ✨ ${annotation}`)
      }
      const notesLine = formatNotesLine(task.notes)
      if (notesLine) {
        lines.push(`    ${notesLine}`)
      }
    }

    sections.push(lines.join('\n'))
  }

  return sections.join('\n\n')
}
