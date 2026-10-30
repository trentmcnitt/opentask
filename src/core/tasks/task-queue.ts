/**
 * The task queue's server switch (2026-10-19, build-plan resolution 11).
 *
 * `OPENTASK_TASK_QUEUE=1` turns on the picks-and-defers rules (a Snooze-all
 * landing at or after the next rollover marks the task for the queue, one
 * High per press, the `summary` wording) and, from task-queue PR 2, the
 * rollover itself. It is a deploy and rollback switch for the whole server —
 * NOT a per-user setting (Trent, 10-19: this is how OpenTask works for
 * everyone). Off: every endpoint behaves exactly as before the queue.
 *
 * Read at call time, never cached, so a test can flip it with
 * `vi.stubEnv('OPENTASK_TASK_QUEUE', '1')`.
 */
/**
 * RULE TQ-SWITCH: OPENTASK_TASK_QUEUE=1 turns on the queue for the whole server: the queue mark,
 *   one High per press, the rollover, the panels, decks and the deadlines page. It is read each
 *   time it is needed. With it off, every endpoint behaves as before the queue, and decks, Roll
 *   over now and defer-lead answer 409.
 * Why: A deploy and rollback switch for the whole server, read at call time so a test can flip it.
 * Ruling: Trent, 2026-10-19: a server-wide deploy/rollback switch, not a per-user setting
 *   (src/core/tasks/task-queue.ts:8).
 */
export function taskQueueEnabled(): boolean {
  return process.env.OPENTASK_TASK_QUEUE === '1'
}
