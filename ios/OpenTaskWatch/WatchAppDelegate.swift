import WatchKit
import UserNotifications
import WatchConnectivity

/// Handles notification actions on Apple Watch.
///
/// When a notification mirrors from iPhone to Watch, the Watch app's
/// UNUserNotificationCenterDelegate handles actions locally instead of
/// forwarding back to the iPhone (which is unreliable when the phone
/// is locked/suspended).
///
/// Registers the same TASK_REMINDER category and action identifiers as
/// the iOS AppDelegate so the Watch recognizes mirrored notification actions.
///
/// Receives credentials from the iPhone via WatchConnectivity. The Watch has
/// its own keychain (separate device from iPhone), so App Group keychain
/// sharing doesn't work across devices. The iPhone sends credentials via
/// WCSession.updateApplicationContext() and the Watch writes them to its
/// local keychain.
class WatchAppDelegate: NSObject, WKApplicationDelegate, UNUserNotificationCenterDelegate, WCSessionDelegate {

    func applicationDidFinishLaunching() {
        UNUserNotificationCenter.current().delegate = self
        registerNotificationCategories()
        activateWatchSession()
        requestNotificationPermission()
    }

    // MARK: - APNs Registration

    /// Request notification permission and register for remote notifications.
    /// The Watch gets its own APNs device token, separate from the iPhone.
    /// This allows the server to send notifications directly to the Watch,
    /// so the Watch app handles actions locally instead of relying on
    /// iPhone mirroring (which doesn't route actions to the Watch app).
    private func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        ) { granted, error in
            if let error = error {
                print("[OpenTaskWatch] Notification permission error: \(error)")
                return
            }
            if granted {
                DispatchQueue.main.async {
                    WKApplication.shared().registerForRemoteNotifications()
                }
            }
        }
    }

    func didRegisterForRemoteNotifications(withDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        print("[OpenTaskWatch] APNs token: \(token)")

        guard APIClient.shared.isConfigured else {
            print("[OpenTaskWatch] Not configured — skipping device registration")
            return
        }

        let bundleId = Bundle.main.bundleIdentifier ?? "io.mcnitt.opentask.watchapp"
        Task {
            do {
                try await APIClient.shared.registerDevice(token: token, bundleId: bundleId)
                print("[OpenTaskWatch] Device registered with server")
            } catch {
                print("[OpenTaskWatch] Device registration failed: \(error)")
            }
        }
    }

    func didFailToRegisterForRemoteNotificationsWithError(_ error: Error) {
        print("[OpenTaskWatch] APNs registration failed: \(error)")
    }

    // MARK: - Silent Push (Cross-Device Dismiss)

    /// When a task is actioned on another device (iPhone, web), the server sends
    /// a silent push to all devices so they can clear the matching notification.
    /// Same pattern as AppDelegate.swift on iOS.
    func didReceiveRemoteNotification(
        _ userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (WKBackgroundFetchResult) -> Void
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
                print("[OpenTaskWatch] Dismissed \(idsToRemove.count) notifications for tasks \(taskIds)")
            }

            completionHandler(idsToRemove.isEmpty ? .noData : .newData)
        }
    }

    // MARK: - WatchConnectivity

    private func activateWatchSession() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if let error = error {
            print("[OpenTaskWatch] WCSession activation failed: \(error)")
        }
    }

    /// Receive credentials from iPhone and save to local keychain.
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let url = applicationContext["serverURL"] as? String,
              let token = applicationContext["bearerToken"] as? String else { return }

        KeychainHelper.save(key: "serverURL", value: url)
        KeychainHelper.save(key: "bearerToken", value: token)
        print("[OpenTaskWatch] Credentials received from iPhone")
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
