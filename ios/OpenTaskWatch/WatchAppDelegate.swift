import WatchKit
import UserNotifications

/// Handles notification actions on Apple Watch.
///
/// When a notification mirrors from iPhone to Watch, the Watch app's
/// UNUserNotificationCenterDelegate handles actions locally instead of
/// forwarding back to the iPhone (which is unreliable when the phone
/// is locked/suspended).
///
/// Registers the same TASK_REMINDER category and action identifiers as
/// the iOS AppDelegate so the Watch recognizes mirrored notification actions.
class WatchAppDelegate: NSObject, WKApplicationDelegate, UNUserNotificationCenterDelegate {

    func applicationDidFinishLaunching() {
        UNUserNotificationCenter.current().delegate = self
        registerNotificationCategories()
    }

    // MARK: - Notification Categories

    /// Register the same TASK_REMINDER category as the iOS app.
    /// Action identifiers must match exactly: DONE, SNOOZE_1HR, SNOOZE_ALL_1HR.
    private func registerNotificationCategories() {
        let doneAction = UNNotificationAction(
            identifier: "DONE",
            title: "Done",
            options: []
        )
        let snoozeAction = UNNotificationAction(
            identifier: "SNOOZE_1HR",
            title: "+1hr",
            options: []
        )
        let snoozeAllAction = UNNotificationAction(
            identifier: "SNOOZE_ALL_1HR",
            title: "All +1hr",
            options: []
        )

        let category = UNNotificationCategory(
            identifier: "TASK_REMINDER",
            actions: [doneAction, snoozeAction, snoozeAllAction],
            intentIdentifiers: [],
            options: []
        )

        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    // MARK: - Handle Notification Actions

    /// Called when the user taps a notification action button on the Watch.
    /// Makes API calls directly from the Watch — no forwarding to iPhone.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let taskId = userInfo["taskId"] as? Int

        // Clear this specific notification on any action
        if taskId != nil {
            center.removeDeliveredNotifications(
                withIdentifiers: [response.notification.request.identifier]
            )
        }

        // Handle silent dismiss pushes (shouldn't reach here, but guard anyway)
        if let type = userInfo["type"] as? String, type == "dismiss" {
            completionHandler()
            return
        }

        guard let taskId = taskId else {
            completionHandler()
            return
        }

        guard APIClient.shared.isConfigured else {
            print("[OpenTaskWatch] API not configured — cannot handle action")
            playHaptic(.failure)
            postLocalErrorNotification("OpenTask not configured. Open the iOS app to set up.")
            completionHandler()
            return
        }

        Task {
            do {
                switch response.actionIdentifier {
                case "DONE":
                    try await APIClient.shared.markDone(taskId: taskId)
                    print("[OpenTaskWatch] Done: task \(taskId)")
                    playHaptic(.success)

                case "SNOOZE_1HR":
                    try await APIClient.shared.snoozeNextHour(taskId: taskId)
                    print("[OpenTaskWatch] Snoozed +1hr: task \(taskId)")
                    playHaptic(.success)

                case "SNOOZE_ALL_1HR":
                    try await APIClient.shared.snoozeOverdue(deltaMinutes: 60)
                    print("[OpenTaskWatch] Snoozed all +1hr")
                    playHaptic(.success)

                case UNNotificationDefaultActionIdentifier:
                    // User tapped the notification body — just clear all
                    center.removeAllDeliveredNotifications()

                default:
                    break
                }
            } catch {
                print("[OpenTaskWatch] Action failed: \(error)")
                playHaptic(.failure)
                postLocalErrorNotification("Action failed: \(error.localizedDescription)")
            }

            completionHandler()
        }
    }

    /// Suppress notifications when the Watch app is in the foreground.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([])
    }

    // MARK: - Haptic Feedback

    private func playHaptic(_ type: WKHapticType) {
        WKInterfaceDevice.current().play(type)
    }

    // MARK: - Error Notification

    /// Post a local notification so the user knows an action failed.
    /// Replaces the iPhone app's silent print() failures with visible feedback.
    private func postLocalErrorNotification(_ message: String) {
        let content = UNMutableNotificationContent()
        content.title = "OpenTask"
        content.body = message
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: "opentask-watch-error-\(Date().timeIntervalSince1970)",
            content: content,
            trigger: nil
        )

        UNUserNotificationCenter.current().add(request) { error in
            if let error = error {
                print("[OpenTaskWatch] Failed to post error notification: \(error)")
            }
        }
    }
}
