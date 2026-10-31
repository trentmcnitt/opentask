/**
 * A QUEUE-MARKED target's words (Trent, 2026-10-31: "Queue tomorrow sounds
 * right"). A defer that lands past the next rollover (B1, `planLanding` in
 * src/core/tasks/bulk.ts) moves the target to the rollover moment and sets
 * `queue_mark`; the rollover then pulls the task into tomorrow's queue. Every
 * surface that draws the target says "Queue tomorrow" instead of "Tomorrow
 * 3:00 AM", in the plain target style and never over target: the rollover
 * runs at the head of the minute tick, so it pulls the task before anything
 * could read it as overdue (src/instrumentation.ts, `makeTaskRollover`).
 *
 * Its own module, not task-model-words.ts: task-segments.ts (`upcomingGap`)
 * reads it, and task-model-words.ts imports task-segments.ts.
 */
export const QUEUE_TOMORROW = 'Queue tomorrow'

/** The task's target is a queue-marked one: it reads `QUEUE_TOMORROW`. */
export function queueMarked(task: { queue_mark?: boolean; due_at: string | null }): boolean {
  return !!task.queue_mark && task.due_at !== null
}

/**
 * Whether a row draws the task as over target: the list's own answer
 * (`isOverdue`, the counts' rule, unchanged), except a queue-marked target —
 * never over, even in a tab left open across the rollover before its refresh.
 */
export function rowOverTarget(
  listOverdue: boolean | undefined,
  task: { queue_mark?: boolean; due_at: string | null },
): boolean {
  return !!listOverdue && !queueMarked(task)
}
