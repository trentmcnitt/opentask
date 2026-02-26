import UIKit
import UserNotifications
import WatchConnectivity

/// Handles APNs registration, notification permission, and push handling.
///
/// Notification categories are registered here so action buttons appear
/// even without the content extension (Phase 3 fallback).
///
/// Also manages WatchConnectivity to sync credentials to the Watch app.
/// The Watch has its own keychain (separate device), so credentials must
/// be transferred via WCSession.updateApplicationContext().
class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate, WCSessionDelegate {

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Migrate keychain items to kSecAttrAccessibleAfterFirstUnlock so they're
        // readable from lock screen notification actions and background contexts.
        KeychainHelper.migrateAccessibility(keys: ["serverURL", "bearerToken"])

        UNUserNotificationCenter.current().delegate = self
        registerNotificationCategories()
        requestNotificationPermission(application)
        activateWatchSession()
        return true
    }

    // MARK: - WatchConnectivity

    /// Activate WCSession so we can send credentials to the Watch app.
    /// Also sends current credentials if already configured (handles the case
    /// where the Watch app is installed after initial iPhone setup).
    private func activateWatchSession() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// Send credentials to Watch via application context.
    /// Called from AppConfig.configure() and on session activation.
    func sendCredentialsToWatch() {
        guard WCSession.isSupported(),
              WCSession.default.activationState == .activated,
              WCSession.default.isPaired,
              WCSession.default.isWatchAppInstalled else { return }

        guard let url = KeychainHelper.read(key: "serverURL"),
              let token = KeychainHelper.read(key: "bearerToken") else { return }

        do {
            try WCSession.default.updateApplicationContext([
                "serverURL": url,
                "bearerToken": token,
            ])
            print("[OpenTask] Sent credentials to Watch")
        } catch {
            print("[OpenTask] Failed to send credentials to Watch: \(error)")
        }
    }

    // MARK: - WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if let error = error {
            print("[OpenTask] WCSession activation failed: \(error)")
            return
        }
        // Send credentials on activation (in case Watch app was installed after setup)
        if activationState == .activated && AppConfig.shared.isConfigured {
            sendCredentialsToWatch()
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) {
        // Re-activate for session switching (e.g., when user switches Watch)
        WCSession.default.activate()
    }

    /// Clear Watch credentials by sending empty context.
    /// Called during disconnect to ensure the Watch app resets to "Not Connected".
    func clearWatchCredentials() {
        guard WCSession.isSupported(),
              WCSession.default.activationState == .activated,
              WCSession.default.isPaired,
              WCSession.default.isWatchAppInstalled else { return }

        do {
            try WCSession.default.updateApplicationContext([
                "serverURL": "",
                "bearerToken": "",
            ])
            print("[OpenTask] Cleared Watch credentials")
        } catch {
            print("[OpenTask] Failed to clear Watch credentials: \(error)")
        }
    }

    // MARK: - Home Screen Quick Actions

    func application(
        _ application: UIApplication,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        print("[OpenTask] Quick action: \(shortcutItem.type)")

        switch shortcutItem.type {
        case "io.mcnitt.opentask.snooze-1hr":
            Task {
                do {
                    let result = try await APIClient.shared.snoozeOverdue(deltaMinutes: 60)
                    print("[OpenTask] Quick action: snoozed \(result.tasksAffected) tasks +1hr")
                } catch {
                    print("[OpenTask] Quick action snooze +1hr error: \(error)")
                }
                completionHandler(true)
            }

        case "io.mcnitt.opentask.snooze-2hr":
            Task {
                do {
                    let result = try await APIClient.shared.snoozeOverdue(deltaMinutes: 120)
                    print("[OpenTask] Quick action: snoozed \(result.tasksAffected) tasks +2hr")
                } catch {
                    print("[OpenTask] Quick action snooze +2hr error: \(error)")
                }
                completionHandler(true)
            }

        case "io.mcnitt.opentask.snooze-tomorrow":
            Task {
                do {
                    // Calculate minutes from now to 9 AM tomorrow in device local time
                    let calendar = Calendar.current
                    let tomorrow = calendar.date(byAdding: .day, value: 1, to: Date())!
                    let tomorrow9am = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow)!
                    let deltaMinutes = max(1, Int(tomorrow9am.timeIntervalSinceNow / 60))

                    let result = try await APIClient.shared.snoozeOverdue(deltaMinutes: deltaMinutes)
                    print("[OpenTask] Quick action: snoozed \(result.tasksAffected) tasks to tomorrow 9am")
                } catch {
                    print("[OpenTask] Quick action snooze tomorrow error: \(error)")
                }
                completionHandler(true)
            }

        case "io.mcnitt.opentask.add-task":
            WebViewManager.shared.navigate(path: "/?action=create")
            completionHandler(true)

        default:
            completionHandler(false)
        }
    }

    /// Clear all delivered notifications when the app comes to foreground,
    /// both locally and across all other devices (web, Watch).
    /// The user can see their task list, so notification noise everywhere should clear.
    func applicationDidBecomeActive(_ application: UIApplication) {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        application.applicationIconBadgeNumber = 0

        // Tell the server to dismiss notifications on all other devices (fire-and-forget)
        guard APIClient.shared.isConfigured else { return }
        Task {
            do {
                try await APIClient.shared.dismissAllNotifications()
            } catch {
                print("[OpenTask] Dismiss-all API error: \(error)")
            }
        }
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
        #if DEBUG
        print("[OpenTask] APNs token: \(token)")
        #endif

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
        guard let type = userInfo["type"] as? String else {
            completionHandler(.noData)
            return
        }

        let center = UNUserNotificationCenter.current()

        // Badge update: server sends current overdue count after mutations
        if type == "badge-update", let badge = userInfo["badge"] as? Int {
            UNUserNotificationCenter.current().setBadgeCount(badge)
            print("[OpenTask] Badge updated to \(badge)")
            completionHandler(.newData)
            return
        }

        // Dismiss-all: user opened the app on another device, clear everything
        if type == "dismiss-all" {
            center.removeAllDeliveredNotifications()
            print("[OpenTask] Dismiss-all: cleared all delivered notifications")
            completionHandler(.newData)
            return
        }

        // Dismiss specific tasks
        guard type == "dismiss",
              let taskIds = userInfo["taskIds"] as? [Int], !taskIds.isEmpty else {
            completionHandler(.noData)
            return
        }

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
                    let result = try await APIClient.shared.snoozeOverdue(deltaMinutes: 60)
                    if result.tasksAffected > 0 {
                        await dismissSnoozedNotifications()
                    }

                case "SNOOZE_CUSTOM", "SNOOZE_ALL_CUSTOM":
                    // These actions are handled entirely by the content extension
                    // (NotificationViewController) which makes the API call directly.
                    // With .dismiss completion, this handler is not reached for these actions.
                    break

                case UNNotificationDefaultActionIdentifier:
                    // User tapped the notification body — open the app and show the task modal.
                    // Navigate the WebView to /?task=<id> so DashboardClient opens QuickActionPanel.
                    UNUserNotificationCenter.current().removeAllDeliveredNotifications()
                    WebViewManager.shared.navigateToTask(taskId)

                default:
                    break
                }
            } catch {
                print("[OpenTask] Action handler error: \(error)")
            }

            completionHandler()
        }
    }

    /// Remove delivered notifications for P0-P3 tasks after bulk snooze.
    /// P4 (Urgent) is never bulk-snoozed, so those notifications remain.
    private func dismissSnoozedNotifications() async {
        let center = UNUserNotificationCenter.current()
        let notifications = await center.deliveredNotifications()
        let idsToRemove = notifications
            .filter { notification in
                let p = notification.request.content.userInfo["priority"] as? Int ?? 0
                return p <= 3
            }
            .map { $0.request.identifier }

        if !idsToRemove.isEmpty {
            center.removeDeliveredNotifications(withIdentifiers: idsToRemove)
            print("[OpenTask] Dismissed \(idsToRemove.count) notifications after bulk snooze")
        }
    }

    /// Called when a notification arrives while the app is in the foreground.
    /// Suppresses all notifications when the app is open — the user is already looking
    /// at their task list. This also prevents the remaining notifications from a cron
    /// batch from chiming after the user opens the app from the first one.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([])
    }
}
