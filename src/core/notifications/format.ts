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
 * RULE INTERRUPTION-LEVEL: Urgent (P4) overdue uses the critical APNs level at the user's volume.
 *   Everything else is active, or passive when it does not lead. The time-sensitive level is not
 *   used.
 * Why: Only Urgent breaks through Focus: nights are the phone's Sleep mode's to handle, not
 *   OpenTask's.
 * Ruling: Trent 2026-10-26 (src/core/notifications/format.ts:23); ruling 4 2026-10-22.
 */
/**
 * APNs interruption level by priority. P4 is a critical alert (bypasses mute
 * and Do Not Disturb, at the user's critical_alert_volume); everything else,
 * High included, is `active` — a banner and a sound that respect Focus.
 *
 * High was `time-sensitive` (it broke through Focus) until 2026-10-26, when
 * Trent ruled that only Urgent breaks through: nights are the phone's Sleep
 * mode's to handle, not OpenTask's.
 */
export function interruptionLevelFor(priority: number): 'critical' | 'active' {
  if (priority >= URGENT_PRIORITY) return 'critical'
  return 'active'
}

/**
 * One overdue banner per task, and one overflow summary: the APNs collapse id
 * AND the Web Push tag (nag-map fix #6), so a repeat replaces the banner it
 * repeats on both channels instead of stacking beside it on the web.
 */
export function taskCollapseId(taskId: number): string {
  return `task-${taskId}`
}
export const OVERDUE_SUMMARY_COLLAPSE_ID = 'overdue-summary'

/**
 * RULE NOTIF-KIND-ICON: Each APNs push kind carries its own icon in
 *   data.icon: quota, reminder, period, task or deadline, with a label-
 *   line subtitle. Web Push has neither and keeps the title's HIGH /
 *   URGENT prefix. The icon also names the banner's kind to the stale
 *   rules.
 * Why: A banner says what kind of thing it is before it is read.
 * Ruling: Trent 2026-11-07: "I like number 5. The left icon is what's important."
 */
/**
 * THE KIND'S ICON AND LABEL LINE (Trent, 2026-11-07, round 4 of the mockups).
 * Five APNs push kinds wear their own icon on the left — the native Notification
 * Service Extension (ios/OpenTaskNotificationService) reads `data.icon` and
 * shows the push as a communication notification with that kind's avatar —
 * and a label line saying what kind it is ("Quota · Health · 1 of 2 today").
 * The label is the alert's `subtitle` (an older build with no extension draws
 * it as a subtitle; the extension, whose style draws none, makes it the body's
 * first line). Only APNs: Web Push has neither, and keeps the title's
 * "HIGH: " / "URGENT: " prefix, which the label line replaces on APNs.
 *
 * `icon`, not `kind`: the deadlines nag's `data.kind` ("deadlines") already
 * routes a body tap natively, so the icon has a field of its own.
 */
export type PushIcon = 'quota' | 'reminder' | 'period' | 'task' | 'deadline'

/** A priority's word on a label line: Urgent, High, Medium, Low; none for None. */
export function priorityWord(priority: number): string | null {
  if (priority >= URGENT_PRIORITY) return 'Urgent'
  if (priority >= HIGH_PRIORITY_THRESHOLD) return 'High'
  if (priority === 2) return 'Medium'
  if (priority === 1) return 'Low'
  return null
}

/** How long ago `since` was, short: "15m", "2h", "3d" (whole units, rounded down; at least 1m). */
export function shortAgo(since: string | Date, now: Date): string {
  const minutes = Math.max(1, Math.floor((now.getTime() - new Date(since).getTime()) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

const labelLine = (parts: (string | null | undefined)[]) =>
  parts.filter((p): p is string => !!p).join(' · ')

/** "Task · High · 2h over target" (the round-4 mockup's words). */
export function taskPushLabel(priority: number, dueAt: string, now: Date): string {
  return labelLine(['Task', priorityWord(priority), `${shortAgo(dueAt, now)} over target`])
}

/** "Reminder · After School". */
export function reminderPushLabel(slotLabel: string): string {
  return labelLine(['Reminder', slotLabel])
}

/** "Period · After School · 5 items" — the reminders and quota prompts waiting. */
export function periodPushLabel(slotLabel: string, items: number): string {
  return labelLine(['Period', slotLabel, items === 1 ? '1 item' : `${items} items`])
}

/** "Quota · Health · 1 of 2 today" — the quota's label when it has one. */
export function quotaPushLabel(label: string | null, spokenCount: string): string {
  return labelLine(['Quota', label, spokenCount])
}

/** "Deadline · due Sun" — the nearest deadline's day. */
export function deadlinePushLabel(nearestDay: string | null): string {
  return labelLine(['Deadline', nearestDay ? `due ${nearestDay}` : null])
}
