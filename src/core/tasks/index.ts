/**
 * Task operations module for OpenTask
 *
 * Provides all task CRUD operations plus mark-done, snooze, and bulk operations.
 */

// Read
export { getTaskById, getTasks } from './read'
export type { GetTasksOptions, TaskKind } from './read'

// Access
export { canUserAccessTask, loadTaskForMutation } from './access'
export type { LoadTaskForMutationOptions } from './access'

// Create
export { createTask } from './create'
export type { CreateTaskOptions } from './create'

// Update
export { updateTask } from './update'
export type { UpdateTaskOptions, UpdateTaskResult } from './update'

// Provenance confirmation (§7.2)
export { confirmTaskProvenance } from './confirm'
export type { ConfirmTaskProvenanceResult } from './confirm'

// Delete
export { deleteTask, restoreTask, emptyTrash } from './delete'
export type { DeleteTaskOptions, RestoreTaskOptions } from './delete'

// Mark done
export { markDone, markUndone } from './mark-done'
export { rolloverTrackedPeriods } from './period-rollover'
export type { MarkDoneOptions, MarkDoneResult } from './mark-done'

// Snooze
export { snoozeTask } from './snooze'
export type { SnoozeTaskOptions, SnoozeResult } from './snooze'

// Reprocess (retry AI enrichment)
export { reprocessTask } from './reprocess'
export type { ReprocessTaskOptions } from './reprocess'

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
