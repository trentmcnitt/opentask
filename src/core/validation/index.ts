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
  TRACKED_REMINDER_MESSAGE,
  QUOTA_DUE_DATE_MESSAGE,
  REMINDER_SNOOZE_MESSAGE,
  QUOTA_DONE_MESSAGE,
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

export { labelCreateSchema, validateLabelCreate } from './label'

export type { LabelCreateInput } from './label'

export {
  timeSlotCreateSchema,
  validateTimeSlotCreate,
  timeSlotUpdateSchema,
  validateTimeSlotUpdate,
} from './time-slot'

export type { TimeSlotCreateInput, TimeSlotUpdateInput } from './time-slot'

export {
  promptKeysSchema,
  bulkCompleteSchema,
  validatePromptKeys,
  validateBulkComplete,
} from './quota-prompt'

export type { PromptKeysInput, BulkCompleteInput } from './quota-prompt'
