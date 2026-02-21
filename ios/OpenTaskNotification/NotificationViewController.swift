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
    private var selectedDueAt: String?
    private var selectedDeltaMinutes: Int?
    private var hasReceivedInitialNotification = false

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
        selectedDueAt = nil
        selectedDeltaMinutes = nil
        restoreDefaultActions()
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

        taskId = userInfo["taskId"] as? Int ?? 0
        dueAt = userInfo["dueAt"] as? String ?? ""

        // Remove existing hosting controller if re-receiving
        hostingController?.view.removeFromSuperview()
        hostingController?.removeFromParent()

        let gridView = SnoozeGridView(
            taskTitle: title,
            originalDueAt: dueAt,
            onGridSelection: { [weak self] newDueAt in
                self?.handleGridSelection(newDueAt)
            },
            onDirtyStateChanged: { [weak self] isDirty in
                self?.updatePreferredContentSize()
                if !isDirty {
                    self?.selectedDueAt = nil
                    self?.selectedDeltaMinutes = nil
                    self?.restoreDefaultActions()
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
    }

    /// Called when the user taps an action button while the extension is visible.
    /// Fires the API call and dismisses the notification.
    func didReceive(
        _ response: UNNotificationResponse,
        completionHandler completion: @escaping (UNNotificationContentExtensionResponseOption) -> Void
    ) {
        Task {
            var bulkSnoozeTier: Int?

            do {
                switch response.actionIdentifier {
                case "DONE":
                    try await APIClient.shared.markDone(taskId: taskId)

                case "SNOOZE_1HR":
                    try await APIClient.shared.snoozeNextHour(taskId: taskId)

                case "SNOOZE_ALL_1HR":
                    let result = try await APIClient.shared.snoozeOverdue(deltaMinutes: 60)
                    bulkSnoozeTier = result.tier

                case "SNOOZE_CUSTOM":
                    if let dueAt = selectedDueAt {
                        try await APIClient.shared.snoozeTo(taskId: taskId, dueAt: dueAt)
                    }

                case "SNOOZE_ALL_CUSTOM":
                    if let delta = selectedDeltaMinutes {
                        let result = try await APIClient.shared.snoozeOverdue(deltaMinutes: delta)
                        bulkSnoozeTier = result.tier
                    }

                default:
                    break
                }
            } catch {
                print("[OpenTask] Content extension action error: \(error)")
            }

            // After bulk snooze, dismiss notifications for tasks that were snoozed,
            // then dismiss this notification. Tier 1 = P0/P1, Tier 2 = P2. P3/P4 never bulk-snoozed.
            // We dismiss other notifications before calling completion so the callback
            // finishes before iOS tears down the extension process.
            if let tier = bulkSnoozeTier, tier > 0 {
                let maxPriority = tier == 1 ? 1 : 2
                await dismissNotifications(atOrBelowPriority: maxPriority)
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

    /// Called when the user taps a grid button. Updates the action buttons to reflect
    /// the selected snooze time with delta labels. If the net change is zero (e.g.,
    /// +1hr then -1hr), restores default action buttons.
    private func handleGridSelection(_ newDueAt: String) {
        selectedDueAt = newDueAt

        // Compute delta from task's original dueAt to selected time
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
            restoreDefaultActions()
            return
        }

        let deltaLabel = DateHelpers.formatDelta(minutes: deltaMinutes)

        // Dynamically replace the notification's action buttons
        extensionContext?.notificationActions = [
            UNNotificationAction(identifier: "DONE", title: "Done", options: []),
            UNNotificationAction(identifier: "SNOOZE_CUSTOM", title: deltaLabel, options: []),
            UNNotificationAction(identifier: "SNOOZE_ALL_CUSTOM", title: "All \(deltaLabel)", options: []),
        ]
    }

    // MARK: - Notification Dismissal

    /// Remove delivered notifications for tasks at or below the given priority.
    /// Used after bulk snooze to clear notifications for tasks that were just snoozed.
    /// Async so the caller can await completion before dismissing the extension.
    private func dismissNotifications(atOrBelowPriority maxPriority: Int) async {
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
            print("[OpenTask] Dismissed \(idsToRemove.count) notifications after bulk snooze (tier priority <= \(maxPriority))")
        }
    }

    // MARK: - Default Actions

    /// Restore the category's default action buttons (Done, +1hr, All +1hr).
    /// Must match the actions registered in AppDelegate.registerNotificationCategories().
    private func restoreDefaultActions() {
        extensionContext?.notificationActions = [
            UNNotificationAction(identifier: "DONE", title: "Done", options: []),
            UNNotificationAction(identifier: "SNOOZE_1HR", title: "+1hr", options: []),
            UNNotificationAction(identifier: "SNOOZE_ALL_1HR", title: "All +1hr", options: []),
        ]
    }
}
