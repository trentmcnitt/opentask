import UserNotifications

/// Shared notification category and action identifiers.
/// Used by AppDelegate (iOS), WatchAppDelegate (watchOS), and the content extension.
/// Must match the `category` field sent by the server in APNs payloads.
enum NotificationCategory {
    static let taskReminder = "TASK_REMINDER"
    static let taskSummary = "TASK_SUMMARY"
    /// REDESIGN-V03 §6: the time SLOT notifies, not the reminder. Long-pressing
    /// one of these expands into the batch checklist (§6.1).
    static let slotReminder = "SLOT_REMINDER"
}

enum NotificationAction {
    static let done = "DONE"
    static let snooze1hr = "SNOOZE_1HR"
    static let snoozeAll1hr = "SNOOZE_ALL_1HR"
    static let snoozeCustom = "SNOOZE_CUSTOM"
    static let snoozeAllCustom = "SNOOZE_ALL_CUSTOM"
    /// §6.1 batch checklist: commit the rows the user checked in the extension.
    /// Only ever offered by the content extension — from the lock screen there
    /// is nothing to check, so the registered category omits it.
    static let completeChecked = "COMPLETE_CHECKED"
    /// Complete every pending reminder in the slot. Meaningful with or without
    /// the expanded UI, so this one IS registered on the category.
    static let completeAll = "COMPLETE_ALL"
}

/// userInfo keys carried by a SLOT_REMINDER push (see `sendApnsSlotReminder`
/// in `src/core/notifications/apns.ts` — this is the whole contract).
enum SlotReminderKey {
    /// `time_slots.id`, or -1 for the un-slotted ("Anytime") group.
    static let slotId = "slot_id"
    static let slotLabel = "slot_label"
    /// Pending count at SEND time — a header fallback only. The expanded
    /// checklist always re-fetches, because by long-press time this is stale.
    static let reminderCount = "reminder_count"
}

/// Register notification categories for the app.
/// Called by both AppDelegate (iOS) and WatchAppDelegate (watchOS).
///
/// Three categories:
/// - TASK_REMINDER: individual task (Done, +1hr, All +1hr)
/// - TASK_SUMMARY: overflow summary (All +1hr only — no single-task actions)
/// - SLOT_REMINDER: §6 time slot (Complete all; long-press expands to the
///   batch checklist, which supplies its own "Complete checked" button)
func registerNotificationCategories() {
    let doneAction = UNNotificationAction(
        identifier: NotificationAction.done,
        title: "Done",
        options: []
    )
    let snoozeAction = UNNotificationAction(
        identifier: NotificationAction.snooze1hr,
        title: "+1hr",
        options: []
    )
    let snoozeAllAction = UNNotificationAction(
        identifier: NotificationAction.snoozeAll1hr,
        title: "All +1hr",
        options: []
    )

    let taskReminderCategory = UNNotificationCategory(
        identifier: NotificationCategory.taskReminder,
        actions: [doneAction, snoozeAction, snoozeAllAction],
        intentIdentifiers: [],
        options: []
    )

    let taskSummaryCategory = UNNotificationCategory(
        identifier: NotificationCategory.taskSummary,
        actions: [snoozeAllAction],
        intentIdentifiers: [],
        options: []
    )

    let completeAllAction = UNNotificationAction(
        identifier: NotificationAction.completeAll,
        title: "Complete all",
        options: []
    )

    let slotReminderCategory = UNNotificationCategory(
        identifier: NotificationCategory.slotReminder,
        actions: [completeAllAction],
        intentIdentifiers: [],
        options: []
    )

    UNUserNotificationCenter.current().setNotificationCategories([
        taskReminderCategory,
        taskSummaryCategory,
        slotReminderCategory,
    ])
}

/// Highest priority the server will include in a bulk snooze.
///
/// Mirrors `HIGH_PRIORITY_THRESHOLD` in `src/lib/priority.ts`: the server
/// snoozes P0-P2 and leaves P3 (High) and P4 (Urgent) alone, because their due
/// dates are real deadlines. Dismissing above this value would clear the banner
/// for a task that was never actually snoozed — it would stay overdue while
/// looking handled, which is the failure this app exists to prevent.
///
/// Keep in sync with the server constant; there is no shared source of truth
/// across the Swift/TypeScript boundary.
let bulkSnoozeMaxPriority = 2

/// Remove delivered notifications for tasks at or below the given priority.
/// Used after bulk snooze to clear notifications for tasks that were just snoozed.
/// P3 (High) and P4 (Urgent) are never bulk-snoozed, so those notifications remain.
func dismissNotifications(atOrBelowPriority maxPriority: Int) async {
    let center = UNUserNotificationCenter.current()
    let notifications = await center.deliveredNotifications()
    let idsToRemove = notifications
        .filter { notification in
            let p = notification.request.content.userInfo["priority"] as? Int ?? 0
            return p <= maxPriority
        }
        .map { $0.request.identifier }

    if !idsToRemove.isEmpty {
        center.removeDeliveredNotifications(withIdentifiers: idsToRemove)
    }
}

/// Update the app icon badge after a notification action.
/// The server also sends a silent badge-update push, but it may not arrive
/// reliably when the app is suspended (iOS throttles silent pushes). Updating
/// locally ensures the badge reflects the action immediately.
/// Only available on iOS — watchOS does not support setBadgeCount.
#if os(iOS)
func updateBadge(_ count: Int) {
    UNUserNotificationCenter.current().setBadgeCount(max(0, count))
}
#else
func updateBadge(_ count: Int) {
    // watchOS does not support app icon badges
}
#endif
