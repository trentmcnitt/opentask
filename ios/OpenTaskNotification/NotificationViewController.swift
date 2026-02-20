import UIKit
import SwiftUI
import UserNotifications
import UserNotificationsUI

/// Notification Content Extension — displays the interactive snooze grid
/// when the user long-presses a task notification.
///
/// Reads task data from the APNs payload and embeds a SwiftUI SnoozeGridView.
/// When the user taps a grid button, the action button labels are dynamically
/// updated to reflect the selected snooze time (e.g., "+7hr" instead of "+1hr").
///
/// Communication flow:
/// 1. User long-presses notification → iOS calls didReceive(_:) with payload
/// 2. User taps grid button → onGridSelection updates action buttons via extensionContext
/// 3. User taps action button → didReceive(_:completionHandler:) fires API call
/// 4. API call succeeds → notification dismissed, forwarded to main app
class NotificationViewController: UIViewController, UNNotificationContentExtension {

    private var hostingController: UIHostingController<SnoozeGridView>?

    // Task data from APNs payload
    private var taskId: Int = 0
    private var dueAt: String = ""
    private var priority: Int = 0
    private var overdueCount: Int = 0
    private var selectedDueAt: String?
    private var selectedDeltaMinutes: Int?

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
    }

    // MARK: - UNNotificationContentExtension

    /// Called when the notification is expanded (long-press). Reads payload and embeds the grid.
    func didReceive(_ notification: UNNotification) {
        let userInfo = notification.request.content.userInfo
        let title = notification.request.content.title

        taskId = userInfo["taskId"] as? Int ?? 0
        dueAt = userInfo["dueAt"] as? String ?? ""
        priority = userInfo["priority"] as? Int ?? 0
        overdueCount = userInfo["overdueCount"] as? Int ?? 0

        // Remove existing hosting controller if re-receiving
        hostingController?.view.removeFromSuperview()
        hostingController?.removeFromParent()

        let gridView = SnoozeGridView(
            taskTitle: title,
            originalDueAt: dueAt,
            overdueCount: overdueCount,
            onGridSelection: { [weak self] newDueAt in
                self?.handleGridSelection(newDueAt)
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
    }

    /// Called when the user taps an action button while the extension is visible.
    /// Fires the API call and dismisses the notification.
    func didReceive(
        _ response: UNNotificationResponse,
        completionHandler completion: @escaping (UNNotificationContentExtensionResponseOption) -> Void
    ) {
        Task {
            do {
                switch response.actionIdentifier {
                case "DONE":
                    try await APIClient.shared.markDone(taskId: taskId)

                case "SNOOZE_1HR":
                    try await APIClient.shared.snoozeNextHour(taskId: taskId)

                case "SNOOZE_ALL_1HR":
                    try await APIClient.shared.snoozeOverdue(deltaMinutes: 60)

                case "SNOOZE_CUSTOM":
                    if let dueAt = selectedDueAt {
                        try await APIClient.shared.snoozeTo(taskId: taskId, dueAt: dueAt)
                    }

                case "SNOOZE_ALL_CUSTOM":
                    if let delta = selectedDeltaMinutes {
                        try await APIClient.shared.snoozeOverdue(deltaMinutes: delta)
                    }

                default:
                    break
                }
            } catch {
                print("[OpenTask] Content extension action error: \(error)")
            }

            // Dismiss and forward to main app for any additional handling
            completion(.dismissAndForwardAction)
        }
    }

    // MARK: - Grid Selection Handler

    /// Called when the user taps a grid button. Updates the action buttons to reflect
    /// the selected snooze time with delta labels.
    private func handleGridSelection(_ newDueAt: String) {
        selectedDueAt = newDueAt

        // Compute delta from task's original dueAt to selected time
        guard let originalDate = DateHelpers.parseISO(dueAt),
              let targetDate = DateHelpers.parseISO(newDueAt)
        else { return }

        let deltaSeconds = targetDate.timeIntervalSince(originalDate)
        let deltaMinutes = Int(deltaSeconds / 60)
        selectedDeltaMinutes = deltaMinutes

        let deltaLabel = DateHelpers.formatDelta(minutes: deltaMinutes)

        // Build updated action buttons with the delta label
        var actions: [UNNotificationAction] = [
            UNNotificationAction(identifier: "DONE", title: "Done", options: []),
            UNNotificationAction(identifier: "SNOOZE_CUSTOM", title: deltaLabel, options: []),
        ]

        // "All" button: only shown when there are overdue P0/P1 tasks
        if overdueCount > 0 {
            actions.append(
                UNNotificationAction(
                    identifier: "SNOOZE_ALL_CUSTOM",
                    title: "All \(deltaLabel)",
                    options: []
                )
            )
        }

        // Dynamically replace the notification's action buttons
        extensionContext?.notificationActions = actions
    }
}
