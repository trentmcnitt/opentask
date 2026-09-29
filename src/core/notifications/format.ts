/**
 * Notification copy and delivery level shared by the overdue checker and the
 * test-notification routes, so a test notification looks exactly like a real one.
 */

import { HIGH_PRIORITY_THRESHOLD, URGENT_PRIORITY } from '@/lib/priority'

/** Base URL for notification tap targets (`/?task=…`, `/?filter=overdue`). */
export const APP_URL = process.env.AUTH_URL || 'http://localhost:3000'

/** Title prefix by priority: "URGENT: " for P4, "HIGH: " for P3, none below. */
export function notificationTitlePrefix(priority: number): string {
  if (priority >= URGENT_PRIORITY) return 'URGENT: '
  if (priority >= HIGH_PRIORITY_THRESHOLD) return 'HIGH: '
  return ''
}

/**
 * APNs interruption level by priority. P4 is a critical alert (bypasses mute
 * and Do Not Disturb, at the user's critical_alert_volume); P3 is
 * time-sensitive (breaks through Focus); the rest are ordinary.
 */
export function interruptionLevelFor(priority: number): 'critical' | 'time-sensitive' | 'active' {
  if (priority >= URGENT_PRIORITY) return 'critical'
  if (priority >= HIGH_PRIORITY_THRESHOLD) return 'time-sensitive'
  return 'active'
}
