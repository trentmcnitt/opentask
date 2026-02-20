import UIKit
import UserNotifications

/// Handles APNs registration, notification permission, and push handling.
///
/// Notification categories are registered here so action buttons appear
/// even without the content extension (Phase 3 fallback).
class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        registerNotificationCategories()
        requestNotificationPermission(application)
        return true
    }

    // MARK: - Notification Permission

    private func requestNotificationPermission(_ application: UIApplication) {
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        ) { granted, error in
            if let error = error {
                print("[OpenTask] Notification permission error: \(error)")
                return
            }
            if granted {
                DispatchQueue.main.async {
                    application.registerForRemoteNotifications()
                }
            }
        }
    }

    // MARK: - APNs Token

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        print("[OpenTask] APNs token: \(token)")

        AppConfig.shared.deviceToken = token

        // Register with server (fire-and-forget)
        guard APIClient.shared.isConfigured else { return }
        let bundleId = Bundle.main.bundleIdentifier ?? "io.mcnitt.opentask"

        Task {
            do {
                try await APIClient.shared.registerDevice(token: token, bundleId: bundleId)
                print("[OpenTask] Device registered with server")
            } catch {
                print("[OpenTask] Device registration failed: \(error)")
            }
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        print("[OpenTask] APNs registration failed: \(error)")
    }

    // MARK: - Notification Categories (Phase 3 defaults)

    /// Register notification categories with default action buttons.
    /// The content extension (Phase 4) dynamically replaces these when the grid is dirty.
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

    // MARK: - Silent Push (Background Notification)

    /// Called when a silent push arrives (content-available: 1).
    /// Used for server-initiated notification dismissal when tasks are snoozed/completed
    /// from another device or the web UI.
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard let type = userInfo["type"] as? String, type == "dismiss",
              let taskIds = userInfo["taskIds"] as? [Int], !taskIds.isEmpty else {
            completionHandler(.noData)
            return
        }

        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { notifications in
            let idsToRemove = notifications
                .filter { notification in
                    guard let notifTaskId = notification.request.content.userInfo["taskId"] as? Int else {
                        return false
                    }
                    return taskIds.contains(notifTaskId)
                }
                .map { $0.request.identifier }

            if !idsToRemove.isEmpty {
                center.removeDeliveredNotifications(withIdentifiers: idsToRemove)
                print("[OpenTask] Dismissed \(idsToRemove.count) notifications for tasks \(taskIds)")
            }

            completionHandler(idsToRemove.isEmpty ? .noData : .newData)
        }
    }

    // MARK: - Handle Notification Actions

    /// Called when user taps a notification action button (from lock screen or notification center).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let taskId = userInfo["taskId"] as? Int

        // Belt-and-suspenders: clear this specific notification on any action
        if taskId != nil {
            UNUserNotificationCenter.current().removeDeliveredNotifications(
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
                    // Set by content extension — read the selected due_at from response
                    if let selectedDueAt = response.notification.request.content.userInfo["selectedDueAt"] as? String {
                        try await APIClient.shared.snoozeTo(taskId: taskId, dueAt: selectedDueAt)
                    }

                case "SNOOZE_ALL_CUSTOM":
                    // Set by content extension — read the delta minutes
                    if let deltaMinutes = response.notification.request.content.userInfo["selectedDeltaMinutes"] as? Int {
                        try await APIClient.shared.snoozeOverdue(deltaMinutes: deltaMinutes)
                    }

                case UNNotificationDefaultActionIdentifier:
                    // User tapped the notification body — open the app (no API call needed)
                    break

                default:
                    break
                }
            } catch {
                print("[OpenTask] Action handler error: \(error)")
            }

            completionHandler()
        }
    }

    /// Called when a notification arrives while the app is in the foreground.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Show banner + sound even when app is open
        completionHandler([.banner, .sound])
    }
}
