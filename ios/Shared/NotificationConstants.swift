import UserNotifications

/// Shared notification category and action identifiers.
/// Used by AppDelegate (iOS), WatchAppDelegate (watchOS), and the content extension.
/// Must match the `category` field sent by the server in APNs payloads.
enum NotificationCategory {
    static let taskReminder = "TASK_REMINDER"
    static let taskSummary = "TASK_SUMMARY"
}

enum NotificationAction {
    static let done = "DONE"
    static let snooze1hr = "SNOOZE_1HR"
    static let snoozeAll1hr = "SNOOZE_ALL_1HR"
    static let snoozeCustom = "SNOOZE_CUSTOM"
    static let snoozeAllCustom = "SNOOZE_ALL_CUSTOM"
}

/// Register notification categories for the app.
/// Called by both AppDelegate (iOS) and WatchAppDelegate (watchOS).
///
/// Two categories:
/// - TASK_REMINDER: individual task (Done, +1hr, All +1hr)
/// - TASK_SUMMARY: overflow summary (All +1hr only — no single-task actions)
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

    UNUserNotificationCenter.current().setNotificationCategories([taskReminderCategory, taskSummaryCategory])
}

/// Remove delivered notifications for tasks at or below the given priority.
/// Used after bulk snooze to clear notifications for tasks that were just snoozed.
/// P4 (Urgent) is never bulk-snoozed, so those notifications remain.
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
