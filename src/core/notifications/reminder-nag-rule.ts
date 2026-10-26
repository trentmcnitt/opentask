/**
 * WHICH REMINDERS GET THEIR OWN PUSH (2026-10-26; plan "named pushes and
 * marks" Part A). A leaf module — no imports — so the task mutations
 * (update.ts, bulk.ts) and the notification senders read one rule.
 *
 * A reminder at Medium or above, with its own Nag on, is pushed BY NAME
 * (reminder-nags.ts) and no longer counted in its period's push or nag
 * (`waitingBySlot`, slot-reminders.ts). Everything else — None and Low, and
 * a Medium+ reminder whose Nag is OFF (`auto_snooze_minutes = 0`) — stays in
 * the period's count. Nag off turns off a reminder's OWN nagging; it never
 * makes a waiting reminder vanish from every notification (coordinator
 * ruling, 2026-10-26, on #368).
 */

/** The lowest priority whose reminders are pushed by name: Medium. */
export const NAMED_REMINDER_MIN_PRIORITY = 2

/** Whether a reminder at this priority is high enough to be pushed by name. */
export function isNamedReminderPriority(priority: number | null | undefined): boolean {
  return (priority ?? 0) >= NAMED_REMINDER_MIN_PRIORITY
}

/**
 * Whether a waiting reminder is pushed by name (and so left out of its
 * period's push and nag): Medium or above, and its own Nag not OFF.
 */
export function getsNamedPush(reminder: {
  priority: number | null | undefined
  auto_snooze_minutes: number | null | undefined
}): boolean {
  return isNamedReminderPriority(reminder.priority) && reminder.auto_snooze_minutes !== 0
}

/**
 * Whether an edit took a reminder OUT of the named pushes — its priority
 * lowered below Medium — so its delivered banner is stale and is dismissed
 * (`dismissNotificationsForTasks`, from update.ts and bulk.ts).
 */
export function leftNamedReminderPush(
  isReminder: boolean,
  priorityBefore: number | null | undefined,
  priorityAfter: number | null | undefined,
): boolean {
  return (
    isReminder && isNamedReminderPriority(priorityBefore) && !isNamedReminderPriority(priorityAfter)
  )
}
