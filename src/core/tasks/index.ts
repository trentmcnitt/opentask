/**
 * Task operations module for OpenTask
 *
 * Provides all task CRUD operations plus mark-done, snooze, and bulk operations.
 */

// Create and read
export { createTask, getTaskById, getTasks } from './create'
export type { CreateTaskOptions, GetTasksOptions } from './create'

// Update
export { updateTask, canUserAccessTask } from './update'
export type { UpdateTaskOptions, UpdateTaskResult } from './update'

// Delete
export { deleteTask, restoreTask, emptyTrash } from './delete'
export type { DeleteTaskOptions, RestoreTaskOptions } from './delete'

// Mark done
export { markDone, markUndone } from './mark-done'
export type { MarkDoneOptions, MarkDoneResult } from './mark-done'

// Snooze
export { snoozeTask } from './snooze'
export type { SnoozeTaskOptions, SnoozeResult } from './snooze'

// Bulk operations
export { bulkDone, bulkSnooze, bulkEdit, bulkDelete } from './bulk'
export type {
  BulkDoneOptions,
  BulkDoneResult,
  BulkSnoozeOptions,
  BulkSnoozeResult,
  BulkEditChanges,
  BulkEditOptions,
  BulkEditResult,
  BulkDeleteOptions,
  BulkDeleteResult,
} from './bulk'
