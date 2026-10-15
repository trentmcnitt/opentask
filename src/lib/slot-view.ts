/**
 * The quotas for the Track panel, in their fixed order. (This file also held
 * the dashboard's Today view — today's tasks by time slot, §7.3 — until that
 * view was dropped on 2026-10-14; see `src/lib/grouping.ts`.)
 */
import { isTracked } from '@/lib/track'
import type { Task } from '@/types'

/**
 * The quotas, for the Track panel: every tracked task, in a fixed alphabetical
 * order so logging on one never reorders the others under the user's finger.
 */
export function trackedItems(tasks: Task[]): Task[] {
  return tasks
    .filter((task) => isTracked(task) && !task.done)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
}
