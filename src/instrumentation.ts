/**
 * Next.js instrumentation hook
 *
 * Runs once when the server starts. Used to initialize cron jobs
 * for the notification service.
 */

export async function register() {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initNotifications } = await import('@/core/notifications')
    initNotifications()
  }
}
