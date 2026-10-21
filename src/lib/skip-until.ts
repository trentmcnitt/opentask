/**
 * Skip until, the client half (task queue PR 4): which tasks it applies to,
 * the request, and the toast. The rule itself lives in
 * `src/core/tasks/skip-until.ts`; this file stays client-safe.
 */

import { isTracked } from '@/lib/track'
import { showToast } from '@/lib/toast'
import type { Task } from '@/types'

/**
 * Whether Skip until applies to a task: a repeating task that is not a
 * reminder or a quota, and not done, archived or trashed. The server applies
 * the same test and counts the rest, so a stale selection is never refused.
 */
export function canSkipUntil(
  task: Pick<
    Task,
    | 'rrule'
    | 'is_reminder'
    | 'is_tracked'
    | 'progress_target'
    | 'done'
    | 'deleted_at'
    | 'archived_at'
  >,
): boolean {
  if (task.done || task.deleted_at || task.archived_at) return false
  return !!task.rrule && !task.is_reminder && !isTracked(task)
}

export interface SkipUntilResponse {
  tasks_affected: number
  occurrences_skipped: number
  /** Nothing to skip, but the target (or a deck) was before the date: moved to the occurrence. */
  targets_moved: number
  skipped_not_repeating: number
  skipped_reminders: number
  skipped_quotas: number
  skipped_inactive: number
  already_clear: number
  task_ids: number[]
  summary: string
}

/**
 * POST /api/tasks/bulk/skip-until. `until` null skips this occurrence. Throws
 * with the server's reason on a refusal.
 */
export async function requestSkipUntil(
  ids: number[],
  until: string | null,
): Promise<SkipUntilResponse> {
  const res = await fetch('/api/tasks/bulk/skip-until', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(until ? { ids, until } : { ids }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error || 'Skip failed')
  }
  return (await res.json()).data as SkipUntilResponse
}

/**
 * The toast, in the server's words (what was skipped, and how many were not
 * repeating or already past the date). Undo only when something was skipped:
 * a batch that skipped nothing writes no undo entry, so an Undo there would
 * reverse whatever came before it.
 */
export function showSkipUntilToast(result: SkipUntilResponse, onUndo: () => void): void {
  if (result.tasks_affected === 0) {
    showToast({ message: result.summary })
    return
  }
  showToast({
    message: result.summary,
    type: 'success',
    action: { label: 'Undo', onClick: onUndo },
  })
}

/**
 * The whole host side of a skip, shared by every surface that offers it (the
 * dashboard's panel and action bar, a task segment's details, the task page):
 * the request, then the host's refresh and undo bookkeeping, then the toast.
 * A failure is toasted and rethrown, so the picker stays open for a retry.
 */
export async function runSkipUntil(
  ids: number[],
  until: string | null,
  host: { onUndo: () => void; afterSkip: (result: SkipUntilResponse) => void },
): Promise<SkipUntilResponse> {
  try {
    const result = await requestSkipUntil(ids, until)
    host.afterSkip(result)
    showSkipUntilToast(result, host.onUndo)
    return result
  } catch (err) {
    showToast({ message: err instanceof Error ? err.message : 'Skip failed', type: 'error' })
    throw err
  }
}
