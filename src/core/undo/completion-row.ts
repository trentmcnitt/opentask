/**
 * Re-create a completion row from the copy an undo snapshot carries.
 *
 * A `done` action's after_state and an `undone` action's before_state both
 * hold `_completion` — the row as it was when the action ran — so the row
 * can come back with its original id when the action is redone (done) or
 * undone (undone).
 */
import type Database from 'better-sqlite3'
import type { Task } from '@/types'

export interface CompletionCopy {
  user_id: number
  completed_at: string
  due_at_was: string | null
  due_at_next: string | null
}

export function reinsertCompletion(
  tx: Database.Database,
  completionId: number,
  taskId: number,
  state: Partial<Task>,
): void {
  const copy = (state as Partial<Task> & { _completion?: CompletionCopy })._completion
  if (!copy) return
  tx.prepare(
    `INSERT INTO completions (id, task_id, user_id, completed_at, due_at_was, due_at_next)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(completionId, taskId, copy.user_id, copy.completed_at, copy.due_at_was, copy.due_at_next)
}
