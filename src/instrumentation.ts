/**
 * Next.js instrumentation hook
 *
 * Runs once when the server starts. Used to initialize cron jobs
 * for the notification service and cleanup tasks.
 */

export async function register() {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const cron = (await import('node-cron')).default
    const { initNotifications } = await import('@/core/notifications')
    const { purgeOldUndoLogs } = await import('@/core/undo/purge')
    const { purgeOldTrash } = await import('@/core/tasks/purge-trash')

    // Start notification service
    initNotifications()

    // Purge old undo logs daily at 3:00 AM
    cron.schedule('0 3 * * *', () => {
      console.log('[cron] Running undo log purge')
      try {
        purgeOldUndoLogs()
      } catch (err) {
        console.error('[cron] Undo log purge error:', err)
      }
    })

    // Purge old trash daily at 3:30 AM
    cron.schedule('30 3 * * *', () => {
      console.log('[cron] Running trash purge')
      try {
        purgeOldTrash()
      } catch (err) {
        console.error('[cron] Trash purge error:', err)
      }
    })

    console.log('[cron] Scheduled daily cleanup jobs (3:00 AM undo purge, 3:30 AM trash purge)')
  }
}
