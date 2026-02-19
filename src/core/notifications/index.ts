/**
 * Notification service exports
 *
 * Note: Cron scheduling is handled in src/instrumentation.ts, not here.
 * This file re-exports the check functions for use by instrumentation and tests.
 */

export { checkOverdueTasks } from './overdue-checker'
export { checkCriticalTasks } from './critical-alerts'
