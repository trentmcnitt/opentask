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
  bulkSnoozeOverdueSchema,
  validateTaskCreate,
  validateTaskUpdate,
  validateSnooze,
  validateBulkDone,
  validateBulkSnooze,
  validateBulkEdit,
  validateBulkDelete,
  validateBulkSnoozeOverdue,
} from './task'

export type {
  TaskCreateInput,
  TaskUpdateInput,
  SnoozeInput,
  BulkDoneInput,
  BulkSnoozeInput,
  BulkEditInput,
  BulkDeleteInput,
  BulkSnoozeOverdueInput,
} from './task'

export {
  projectCreateSchema,
  projectUpdateSchema,
  validateProjectCreate,
  validateProjectUpdate,
} from './project'

export type { ProjectCreateInput, ProjectUpdateInput } from './project'

export {
  webhookCreateSchema,
  webhookUpdateSchema,
  validateWebhookCreate,
  validateWebhookUpdate,
} from './webhook'

export type { WebhookCreateInput, WebhookUpdateInput } from './webhook'
