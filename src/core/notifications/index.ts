/**
 * Notification service exports
 *
 * Note: Cron scheduling is handled in src/instrumentation.ts, not here.
 * This file re-exports the check functions for use by instrumentation and tests.
 */

export { checkOverdueTasks } from './overdue-checker'
export { checkSlotReminders, pendingSlotNotifications, slotsDueNow } from './slot-reminders'
export {
  checkSlotNags,
  pendingSlotNags,
  recordSlotNag,
  purgeOldSlotNags,
  isAwake,
  wakingWindowMinutes,
  minNagGapHours,
  slotNagBody,
  MAX_NAGS_PER_DAY,
} from './slot-nags'
export { dismissNotificationsForTasks } from './dismiss'
