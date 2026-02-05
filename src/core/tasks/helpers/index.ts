/**
 * Shared helpers for task operations
 *
 * These helpers extract common logic used by both single and bulk operations.
 */

export { computeMarkDone } from './compute-mark-done'
export type { MarkDoneComputation, MarkDoneStats } from './compute-mark-done'

export { executeMarkDone } from './execute-mark-done'
export type { ExecuteMarkDoneResult } from './execute-mark-done'

export { collectFieldChanges } from './collect-field-changes'
export type {
  FieldChangeData,
  FieldChangesInput,
  CollectFieldChangesOptions,
} from './collect-field-changes'
