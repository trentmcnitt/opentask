/**
 * WHICH REMINDERS GET THEIR OWN PUSH (2026-10-26; plan "named pushes and
 * marks" Part A). A leaf module — no imports — so the task mutations
 * (update.ts, bulk.ts) and the notification senders read one rule.
 *
 * A reminder at Medium or above is pushed BY NAME (reminder-nags.ts) and no
 * longer counted in its period's push or nag (`waitingBySlot`,
 * slot-reminders.ts); None and Low stay in the period's count. That split is
 * by priority alone: a Medium+ reminder whose own Nag is OFF
 * (`auto_snooze_minutes = 0`) gets no named push AND stays out of the period
 * count — "off means off", as on the deadlines page (coordinator ruling,
 * 2026-10-22).
 */

/** The lowest priority whose reminders are pushed by name: Medium. */
export const NAMED_REMINDER_MIN_PRIORITY = 2

/** Whether a reminder at this priority is pushed by name rather than counted in its period. */
export function isNamedReminderPriority(priority: number | null | undefined): boolean {
  return (priority ?? 0) >= NAMED_REMINDER_MIN_PRIORITY
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
