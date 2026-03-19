import UIKit
import SwiftUI
import UserNotifications
import UserNotificationsUI

/// Notification Content Extension — displays the interactive snooze grid
/// when the user long-presses a task notification.
///
/// Handles two notification categories:
/// - **TASK_REMINDER**: individual task — grid uses the task's dueAt as the base time,
///   action buttons include Done, single-task snooze, and bulk snooze.
/// - **TASK_SUMMARY**: overflow summary — grid uses "now" as the base time,
///   action buttons are bulk-only (no Done or single-task snooze).
///
/// Communication flow:
/// 1. User long-presses notification → iOS calls didReceive(_:) with payload
/// 2. User taps grid button → onGridSelection updates action buttons via extensionContext
/// 3. User taps action button → didReceive(_:completionHandler:) fires API call
/// 4. API call succeeds → notification dismissed
class NotificationViewController: UIViewController, UNNotificationContentExtension {

    private var hostingController: UIHostingController<SnoozeGridView>?

    // Task data from APNs payload
    private var taskId: Int = 0
    private var dueAt: String = ""
    private var overdueCount: Int?
    private var selectedDueAt: String?
    private var selectedDeltaMinutes: Int?
    private var hasReceivedInitialNotification = false

    /// True when displaying a TASK_SUMMARY notification (bulk-only actions, no taskId).
    private var isBulkMode = false

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Reset state so the next long-press rebuilds the grid and action buttons fresh.
        // iOS reuses the extension instance for the same notification, so without this
        // the custom action buttons (e.g., "+3hr") persist even though the grid resets.
        hasReceivedInitialNotification = false
        isBulkMode = false
        selectedDueAt = nil
        selectedDeltaMinutes = nil
        setDefaultTimeActions()
    }

    // MARK: - UNNotificationContentExtension

    /// Called when the notification is expanded (long-press) and again for each
    /// subsequent notification that arrives while the extension is visible.
    /// We lock to the first notification so the UI stays stable while the user
    /// is interacting with it — a burst of incoming notifications must not
    /// swap the task out from under them.
    func didReceive(_ notification: UNNotification) {
        if hasReceivedInitialNotification { return }
        hasReceivedInitialNotification = true

        let userInfo = notification.request.content.userInfo
        let title = notification.request.content.title
        let categoryId = notification.request.content.categoryIdentifier

        isBulkMode = categoryId == NotificationCategory.taskSummary

        // Remove existing hosting controller if re-receiving
        hostingController?.view.removeFromSuperview()
        hostingController?.removeFromParent()

        let mode: SnoozeMode
        if isBulkMode {
            let overflowCount = userInfo["overflowCount"] as? Int ?? 0
            let totalOverdueCount = userInfo["totalOverdueCount"] as? Int ?? overflowCount
            mode = .bulk(taskCount: totalOverdueCount)
            // Use "now" as the base time for bulk mode (no single task's dueAt)
            dueAt = DateHelpers.formatISO(Date())
        } else {
            taskId = userInfo["taskId"] as? Int ?? 0
            dueAt = userInfo["dueAt"] as? String ?? ""
            overdueCount = userInfo["overdueCount"] as? Int
            mode = .individual(taskTitle: title, originalDueAt: dueAt)
        }

        let gridView = SnoozeGridView(
            mode: mode,
            onGridSelection: { [weak self] newDueAt in
                self?.handleGridSelection(newDueAt)
            },
            onDirtyStateChanged: { [weak self] isDirty in
                self?.updatePreferredContentSize()
                if !isDirty {
                    self?.selectedDueAt = nil
                    self?.selectedDeltaMinutes = nil
                    self?.setDefaultTimeActions()
                }
            }
        )

        let hosting = UIHostingController(rootView: gridView)
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        hosting.view.backgroundColor = .clear

        addChild(hosting)
        view.addSubview(hosting.view)
        hosting.didMove(toParent: self)

        NSLayoutConstraint.activate([
            hosting.view.topAnchor.constraint(equalTo: view.topAnchor),
            hosting.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        hostingController = hosting

        // Set initial action buttons with absolute time (e.g., "4:00 PM" instead of "+1hr")
        setDefaultTimeActions()
    }

    /// Called when the user taps an action button while the extension is visible.
    /// Fires the API call and dismisses the notification.
    func didReceive(
        _ response: UNNotificationResponse,
        completionHandler completion: @escaping (UNNotificationContentExtensionResponseOption) -> Void
    ) {
        Task {
            var wasBulkSnooze = false

            do {
                if isBulkMode {
                    // Bulk mode: all actions are bulk snooze (no Done or single-task snooze)
                    switch response.actionIdentifier {
                    case NotificationAction.snoozeAll1hr:
                        let result = try await APIClient.shared.snoozeOverdue(deltaMinutes: 60)
                        wasBulkSnooze = result.tasksAffected > 0
                        updateBadge(result.skippedUrgent)

                    case NotificationAction.snoozeAllCustom:
                        if let dueAt = selectedDueAt {
                            let result = try await APIClient.shared.snoozeOverdue(until: dueAt)
                            wasBulkSnooze = result.tasksAffected > 0
                            updateBadge(result.skippedUrgent)
                        }

                    default:
                        break
                    }
                } else {
                    // Individual mode: task-specific + bulk actions
                    switch response.actionIdentifier {
                    case NotificationAction.done:
                        try await APIClient.shared.markDone(taskId: taskId)
                        if let count = overdueCount { updateBadge(count - 1) }

                    case NotificationAction.snooze1hr:
                        try await APIClient.shared.snoozeNextHour(taskId: taskId)
                        if let count = overdueCount { updateBadge(count - 1) }

                    case NotificationAction.snoozeAll1hr:
                        let result = try await APIClient.shared.snoozeOverdue(deltaMinutes: 60, includeTaskId: taskId)
                        wasBulkSnooze = result.tasksAffected > 0
                        updateBadge(result.skippedUrgent)

                    case NotificationAction.snoozeCustom:
                        if let dueAt = selectedDueAt {
                            try await APIClient.shared.snoozeTo(taskId: taskId, dueAt: dueAt)
                            if let count = overdueCount { updateBadge(count - 1) }
                        }

                    case NotificationAction.snoozeAllCustom:
                        if let dueAt = selectedDueAt {
                            let result = try await APIClient.shared.snoozeOverdue(until: dueAt, includeTaskId: taskId)
                            wasBulkSnooze = result.tasksAffected > 0
                            updateBadge(result.skippedUrgent)
                        }

                    default:
                        break
                    }
                }
            } catch {
                print("[OpenTask] Content extension action error: \(error)")
                // Keep notification visible so the user knows it failed
                completion(.doNotDismiss)
                return
            }

            // After bulk snooze, dismiss notifications for P0-P3 tasks that were snoozed.
            // P4 (Urgent) is never bulk-snoozed, so those notifications remain.
            if wasBulkSnooze {
                await dismissNotifications(atOrBelowPriority: 3)
            }

            // Dismiss only — the extension already handled the action via API call.
            // Using .dismissAndForwardAction would cause AppDelegate's didReceive to
            // fire the same API call again (double action).
            completion(.dismiss)
        }
    }

    // MARK: - Size Management

    /// Re-measure the SwiftUI hosting controller and update preferredContentSize
    /// so the notification extension expands to fit the resolved-time preview bar.
    private func updatePreferredContentSize() {
        guard let hosting = hostingController else { return }
        let targetSize = CGSize(width: view.bounds.width, height: UIView.layoutFittingCompressedSize.height)
        let fittingSize = hosting.view.systemLayoutSizeFitting(
            targetSize,
            withHorizontalFittingPriority: .required,
            verticalFittingPriority: .fittingSizeLevel
        )
        preferredContentSize = CGSize(width: view.bounds.width, height: fittingSize.height)
    }

    // MARK: - Grid Selection Handler

    /// Called when the user taps a grid button. Updates the action buttons to show
    /// the resolved absolute time. If the net change is zero (e.g., +1hr then -1hr),
    /// restores default action buttons.
    private func handleGridSelection(_ newDueAt: String) {
        selectedDueAt = newDueAt

        // Compute delta from base time to selected time
        guard let originalDate = DateHelpers.parseISO(dueAt),
              let targetDate = DateHelpers.parseISO(newDueAt)
        else { return }

        let deltaSeconds = targetDate.timeIntervalSince(originalDate)
        let deltaMinutes = Int(deltaSeconds / 60)
        selectedDeltaMinutes = deltaMinutes

        // Net-zero: user adjusted back to the original time — reset to defaults
        if deltaMinutes == 0 {
            selectedDueAt = nil
            selectedDeltaMinutes = nil
            setDefaultTimeActions()
            return
        }

        let timeLabel = DateHelpers.formatShortTime(targetDate)

        if isBulkMode {
            // Bulk mode: only bulk snooze action
            extensionContext?.notificationActions = [
                UNNotificationAction(identifier: NotificationAction.snoozeAllCustom, title: "All \u{2192} \(timeLabel)", options: []),
            ]
        } else {
            // Individual mode: Done, single snooze, bulk snooze
            extensionContext?.notificationActions = [
                UNNotificationAction(identifier: NotificationAction.done, title: "Done", options: []),
                UNNotificationAction(identifier: NotificationAction.snoozeCustom, title: timeLabel, options: []),
                UNNotificationAction(identifier: NotificationAction.snoozeAllCustom, title: "All \u{2192} \(timeLabel)", options: []),
            ]
        }
    }

    // MARK: - Default Actions

    /// Set action buttons showing the absolute "next hour" time (e.g., "4:00 PM").
    /// Called on initial notification expansion and when the grid resets to clean state.
    private func setDefaultTimeActions() {
        let nextHour = DateHelpers.snapToNextHour()
        let timeLabel = DateHelpers.formatShortTime(nextHour)

        if isBulkMode {
            extensionContext?.notificationActions = [
                UNNotificationAction(identifier: NotificationAction.snoozeAll1hr, title: "All \u{2192} \(timeLabel)", options: []),
            ]
        } else {
            extensionContext?.notificationActions = [
                UNNotificationAction(identifier: NotificationAction.done, title: "Done", options: []),
                UNNotificationAction(identifier: NotificationAction.snooze1hr, title: timeLabel, options: []),
                UNNotificationAction(identifier: NotificationAction.snoozeAll1hr, title: "All \u{2192} \(timeLabel)", options: []),
            ]
        }
    }
}
