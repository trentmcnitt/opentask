/**
 * A PRE-MIGRATION AUTOMATIC TARGET coming back to life (the deadlines page,
 * 2026-10-22; plan §6). `migrateDeadlineLeads` converts every OPEN one-off on
 * an automatic target once; a done or trashed one keeps its `target_auto`
 * row. When such a task is reopened (put back) or restored from the trash
 * with the task-queue switch on, it is converted in the same write — the
 * automatic target goes (`due_at`, `original_due_at` NULL, `target_auto` 0),
 * the lead day is derived now (`leadFor`), and any queue state goes with it
 * (a deadline task is never queued) — so no automatic target ever nags again.
 * The callers put these fields in their own UPDATE and undo snapshot.
 */
import type { Task } from '@/types'
import { leadFor } from '@/lib/task-segments'
import { taskQueueEnabled } from './task-queue'
import { rolloverTimeForUser } from './rollover-time'
import { getTargetContext } from './target-context'

export interface AutoTargetConversion {
  /** SQL SET fragment (one `?`: the lead day). */
  sql: string
  values: unknown[]
  fields: (keyof Task)[]
  before: Partial<Task>
  after: Partial<Task>
}

/**
 * The lead day the deadlines page derives for a deadline one-off (`leadFor`,
 * in the owner's zone and OpenTask day), as `migrateDeadlineLeads` does at
 * startup. Shared with the undo fence (`auto-target-fence.ts`).
 */
export function oneOffLeadFrom(
  task: Pick<Task, 'user_id' | 'lead_days'> & { deadline_at: string },
  now: Date = new Date(),
): string | null {
  return leadFor(
    {
      rrule: null,
      repeat_anchor: null,
      target_days_before: null,
      target_time: null,
      deadline_at: task.deadline_at,
      lead_days: task.lead_days,
    },
    getTargetContext(task.user_id).timezone,
    { rolloverTime: rolloverTimeForUser(task.user_id), now },
  )
}

export function autoTargetToLead(task: Task, now: Date = new Date()): AutoTargetConversion | null {
  if (!taskQueueEnabled() || !task.target_auto || task.rrule || !task.deadline_at) return null
  const leadFrom = oneOffLeadFrom({ ...task, deadline_at: task.deadline_at }, now)
  const after: Partial<Task> = {
    due_at: null,
    original_due_at: null,
    target_auto: false,
    lead_from: leadFrom,
    queued_at: null,
    try_tomorrow: false,
    queue_mark: false,
  }
  const fields = Object.keys(after) as (keyof Task)[]
  const before = Object.fromEntries(fields.map((f) => [f, task[f]])) as Partial<Task>
  return {
    sql:
      'due_at = NULL, original_due_at = NULL, target_auto = 0, lead_from = ?, ' +
      'queued_at = NULL, try_tomorrow = 0, queue_mark = 0',
    values: [leadFrom],
    fields,
    before,
    after,
  }
}
