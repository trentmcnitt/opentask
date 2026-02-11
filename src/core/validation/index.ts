/**
 * Validation module for OpenTask
 */

export {
  taskCreateSchema,
  taskUpdateSchema,
  snoozeSchema,
  bulkDoneSchema,
  bulkSnoozeSchema,
  bulkEditSchema,
  bulkDeleteSchema,
  validateTaskCreate,
  validateTaskUpdate,
  validateSnooze,
  validateBulkDone,
  validateBulkSnooze,
  validateBulkEdit,
  validateBulkDelete,
} from './task'

export type {
  TaskCreateInput,
  TaskUpdateInput,
  SnoozeInput,
  BulkDoneInput,
  BulkSnoozeInput,
  BulkEditInput,
  BulkDeleteInput,
} from './task'

export {
  projectCreateSchema,
  projectUpdateSchema,
  validateProjectCreate,
  validateProjectUpdate,
} from './project'

export type { ProjectCreateInput, ProjectUpdateInput } from './project'
