/**
 * Notification service initialization
 *
 * Sets up cron jobs for overdue checking and critical alerts.
 */

import cron from 'node-cron'
import { checkOverdueTasks } from './overdue-checker'
import { checkCriticalTasks } from './critical-alerts'
import { log } from '@/lib/logger'

let initialized = false

export function initNotifications(): void {
  if (initialized) return
  initialized = true

  log.info('notifications', 'Starting notification service')

  // Check for overdue tasks every minute (per-task intervals handle repeat frequency)
  cron.schedule('* * * * *', async () => {
    log.info('notifications', 'Running overdue check')
    await checkOverdueTasks()
  })

  // Check for critical tasks every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    log.info('notifications', 'Running critical check')
    await checkCriticalTasks()
  })

  // Run initial check on startup (after a short delay to let DB initialize)
  setTimeout(async () => {
    log.info('notifications', 'Running initial overdue check')
    await checkOverdueTasks()
    await checkCriticalTasks()
  }, 5000)
}
