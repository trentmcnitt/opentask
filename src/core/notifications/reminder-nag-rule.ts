/**
 * WHICH REMINDERS GET THEIR OWN PUSH (2026-10-26; plan "named pushes and
 * marks" Part A). A leaf module — no imports — so the period push, the
 * period nag and the named pushes read one rule.
 *
 * PRIORITY IS THE ONE DIAL (Trent, 2026-10-26: "Turn off every nag-specific
 * option for reminders"). A reminder at Medium or above is pushed BY NAME
 * (reminder-nags.ts) and no longer counted in its period's push or nag
 * (`waitingBySlot`, slot-reminders.ts); None and Low stay in the period's
 * count, and each paces the period nag at its own priority. A reminder's
 * stored `auto_snooze_minutes` is IGNORED for all of it — not read, not
 * rewritten — so a task made a reminder and back keeps whatever it had.
 * (From #368 to this ruling, a Medium+ reminder with Nag off was the
 * period's instead; that rule is gone.)
 *
 * When a delivered named-push banner goes stale after an edit (priority
 * lowered, converted to a task, moved to Anytime or off today), the task
 * mutations dismiss it: `namedPushEndCheck` in reminder-nags.ts.
 */

/** The lowest priority whose reminders are pushed by name: Medium. */
export const NAMED_REMINDER_MIN_PRIORITY = 2

/** Whether a reminder at this priority is high enough to be pushed by name. */
export function isNamedReminderPriority(priority: number | null | undefined): boolean {
  return (priority ?? 0) >= NAMED_REMINDER_MIN_PRIORITY
}

/**
 * Whether a waiting reminder is pushed by name (and so left out of its
 * period's push and nag): by its priority alone.
 */
export function getsNamedPush(reminder: { priority: number | null | undefined }): boolean {
  return isNamedReminderPriority(reminder.priority)
}
