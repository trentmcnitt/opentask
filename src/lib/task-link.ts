/**
 * What the dashboard does with a `/?task=<id>` link, one step at a time.
 *
 * The bare `/?task=<id>` is a NOTIFICATION tap — every producer is one: the
 * iPhone and Mac apps (`WebViewManager.navigateToTask` →
 * `DeepLinkRouter.notificationTaskPath`) and Web Push (`overdue-checker.ts`,
 * `enrichment-notify.ts`, the test notification). It means "show me that
 * task": its row is brought on screen and SELECTED, so the floating action bar
 * is up for the thing the notification was about. It opens no editor, no
 * sheet (Trent, 2026-09-29 — it used to open the quick panel).
 *
 * Making the row reachable can take a couple of renders, so this is a step
 * function the `?task=` effect in `DashboardClient.tsx` calls on each render
 * until it returns something final:
 *
 * 1. `missing`: not in the open-task list — done, deleted, someone else's, or
 *    never existed. The caller says so in a toast.
 * 2. `quota` / `reminder`: not a dashboard row at all (§5, §6). The caller
 *    sends it to its own surface (`/quotas?quota=`, `/reminders?reminder=`).
 * 3. `show`: the row is in a group of the list as drawn. The caller unfolds
 *    the group, flashes and scrolls to the row, and selects it.
 * 4. `clear-narrowing`: a search, filter chip or AI chip hides it. Cleared
 *    only then — "only if necessary" — and once.
 * 5. `switch-view`: the list has it but the view drops it. Only Today does
 *    that (it keeps what is due by the end of today), so the caller shows All
 *    for this visit, without saving it as the preference. Once.
 * 6. `unreachable`: both corrections are spent and there is still no row.
 *    Should not happen; the caller toasts rather than loop.
 */

import type { GroupingMode } from '@/lib/grouping'
import { isFlatGrouping } from '@/lib/task-grouping'
import { isTracked } from '@/lib/track'
import type { Task } from '@/types'

export type TaskLinkStep =
  | { kind: 'missing' }
  | { kind: 'quota'; task: Task }
  | { kind: 'reminder'; task: Task }
  | { kind: 'show'; task: Task; groupLabel: string }
  | { kind: 'clear-narrowing' }
  | { kind: 'switch-view' }
  | { kind: 'unreachable'; task: Task }

export interface TaskLinkInput {
  taskId: number
  /** Every open task the page loaded — reminders and quotas included. */
  tasks: Task[]
  /** The dashboard's list after search, filter chips and AI chips. */
  listed: Task[]
  /** The list's groups as drawn in the current view. */
  groups: { label: string; tasks: Task[] }[]
  grouping: GroupingMode
  /** Corrections already made for this link. */
  tried: { narrowing: boolean; view: boolean }
}

export function resolveTaskLink(input: TaskLinkInput): TaskLinkStep {
  const { taskId, tasks, listed, groups, grouping, tried } = input
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return { kind: 'missing' }
  if (isTracked(task)) return { kind: 'quota', task }
  if (task.is_reminder) return { kind: 'reminder', task }

  const group = groups.find((g) => g.tasks.some((t) => t.id === taskId))
  if (group) return { kind: 'show', task, groupLabel: group.label }

  if (!listed.some((t) => t.id === taskId)) {
    return tried.narrowing ? { kind: 'unreachable', task } : { kind: 'clear-narrowing' }
  }
  if (!tried.view && grouping !== 'time' && !isFlatGrouping(grouping)) {
    return { kind: 'switch-view' }
  }
  return { kind: 'unreachable', task }
}

/**
 * The toast for a link whose task isn't open, from `GET /api/tasks/<id>`'s
 * answer (null when that failed or the task isn't the user's).
 */
export function missingTaskMessage(
  task: { title: string; done: boolean; deleted_at: string | null } | null,
): string {
  if (task?.deleted_at) return `“${task.title}” is in the trash`
  if (task?.done) return `“${task.title}” is already done`
  return 'That task no longer exists'
}
