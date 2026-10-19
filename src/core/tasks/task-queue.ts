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
export function taskQueueEnabled(): boolean {
  return process.env.OPENTASK_TASK_QUEUE === '1'
}
