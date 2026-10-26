/**
 * WHICH REMINDERS GET THEIR OWN PUSH (2026-10-26; plan "named pushes and
 * marks" Part A). A leaf module — no imports — so the period push, the
 * period nag and the named pushes read one rule.
 *
 * A reminder at Medium or above, with its own Nag on, is pushed BY NAME
 * (reminder-nags.ts) and no longer counted in its period's push or nag
 * (`waitingBySlot`, slot-reminders.ts). Everything else — None and Low, and
 * a Medium+ reminder whose Nag is OFF (`auto_snooze_minutes = 0`) — stays in
 * the period's count. Nag off turns off a reminder's OWN nagging; it never
 * makes a waiting reminder vanish from every notification (coordinator
 * ruling, 2026-10-26, on #368). Such a one paces the period nag like a Low
 * one (`periodPacePriority`).
 *
 * When a delivered named-push banner goes stale after an edit (priority
 * lowered, Nag off, converted to a task, moved to Anytime or off today), the
 * task mutations dismiss it: `namedPushStands` in reminder-nags.ts.
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

/** Low: the pace a Medium+ reminder with its Nag off gives the period nag. */
const NAG_OFF_PACE_PRIORITY = 1

/**
 * The priority a reminder counted in its period paces the period nag at:
 * its own — except a Medium+ one with its Nag off, which "behaves like a
 * None/Low reminder" (coordinator ruling, 2026-10-26) and paces like a Low
 * one rather than at its High or Urgent rung.
 */
export function periodPacePriority(reminder: {
  priority: number | null | undefined
  auto_snooze_minutes: number | null | undefined
}): number {
  const priority = reminder.priority ?? 0
  return isNamedReminderPriority(priority) && reminder.auto_snooze_minutes === 0
    ? NAG_OFF_PACE_PRIORITY
    : priority
}
