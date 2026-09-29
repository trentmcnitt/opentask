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

        // Refresh the cached time slots (fire-and-forget) so the slot-snooze
        // notification actions catch up to any change made elsewhere, without
        // blocking the initial (cache-only) category registration above on a
        // network round trip.
        Task { await refreshSlotActions() }

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
    //
    // The scene's delegate class is `QuickActionSceneDelegate`, which receives
    // quick actions on cold launch (`connectionOptions.shortcutItem`) and warm
    // launch (`performActionFor`) — see its doc.

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        config.delegateClass = QuickActionSceneDelegate.self
        return config
    }

    /// Clear this device's delivered notifications when the app comes to the
    /// foreground — and, ONLY when there were some, the other devices' too.
    ///
    /// Why the cross-device part exists (e4d5a7c, 2026-02): a notification
    /// burst lands on every device at once (phone, Watch, web). Opening the
    /// app to deal with it should silence the copies everywhere, not leave
    /// the Watch chiming through the rest of the burst.
    ///
    /// Why it's narrowed (2026-09-24): it used to call `dismiss-all` on EVERY
    /// activation — every app open, every return from the app switcher,
    /// Control Center, a system alert — so merely glancing at the phone app
    /// wiped the Watch's and the web's notifications, including ones the user
    /// hadn't seen or dealt with. Now it fires only when THIS device had
    /// delivered notifications at the moment it became active: that is the
    /// "the user is responding to the burst" signal the feature was built on.
    /// No delivered notifications here means this device isn't the one the
    /// user is answering, so there is nothing to tell the others. A repeat
    /// activation (Control Center pulled down and back) finds the list already
    /// cleared by the first one and stays local.
    ///
    /// The local clear stays unconditional. (The macOS app never calls
    /// `dismiss-all` at all — see `MacAppDelegate`. The web app's own
    /// visibility-change `dismiss-all` in `AppLayout.tsx` skips itself inside
    /// either native shell, so this is the ONE place the phone app decides.)
    ///
    /// The badge is NOT zeroed here any more (2026-09-29). It used to be, on
    /// every activation, so opening the app — even for a second — wiped the
    /// badge while tasks were still overdue, and nothing put it back until the
    /// next push. Now activation asks the server for the Tasks page's own
    /// overdue count (`refreshBadgeFromServer()`, `GET /api/tasks/counts`)
    /// and shows that: the badge the user sees on leaving the app matches the
    /// red pill they were just looking at.
    func applicationDidBecomeActive(_ application: UIApplication) {
        let center = UNUserNotificationCenter.current()
        Task { await refreshBadgeFromServer() }

        // Refresh the slot-snooze action list on every foreground too, not
        // just launch — slots are user-configurable and this app can stay
        // backgrounded for a long time.
        Task { await refreshSlotActions() }

        center.getDeliveredNotifications { delivered in
            center.removeAllDeliveredNotifications()

            guard !delivered.isEmpty, APIClient.shared.isConfigured else { return }
            Task {
                do {
                    try await APIClient.shared.dismissAllNotifications()
                } catch {
                    print("[OpenTask] Dismiss-all API error: \(error)")
                }
            }
        }
    }

    // MARK: - Notification Permission

    private func requestNotificationPermission(_ application: UIApplication) {
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound, .criticalAlert]
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

        // Inject token into live WebView so the web app can register it via session cookie.
        // This handles the case where APNs token arrives after WebView has already loaded.
        // The CustomEvent wakes up the PreferencesProvider listener if it already mounted.
        DispatchQueue.main.async {
            let js = WebBridge.deviceInfoJS(token: token)
                + "window.dispatchEvent(new CustomEvent('opentask-device-token'));"
            WebViewManager.shared.webView?.evaluateJavaScript(js)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        print("[OpenTask] APNs registration failed: \(error)")
    }

    // MARK: - Notification Categories (delegated to Shared/NotificationConstants.swift)

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

        // Legacy: servers before 2026-09-29 sent the badge as a SILENT push
        // with the count in `badge`. Current servers send an alert-type push
        // carrying only `aps.badge`, which iOS applies itself and which never
        // reaches this method. Kept so this build still works against an
        // older server.
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
    /// Branches on category: TASK_SUMMARY actions don't have a taskId (bulk operations only),
    /// while TASK_REMINDER actions target a specific task.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let categoryId = response.notification.request.content.categoryIdentifier

        // Handle silent dismiss pushes (shouldn't reach here, but guard anyway)
        if let type = userInfo["type"] as? String, type == "dismiss" {
            completionHandler()
            return
        }

        // Summary notifications: bulk-only actions, no taskId
        if categoryId == NotificationCategory.taskSummary {
            UNUserNotificationCenter.current().removeDeliveredNotifications(
                withIdentifiers: [response.notification.request.identifier]
            )

            Task {
                do {
                    switch response.actionIdentifier {
                    case NotificationAction.snoozeAll1hr:
                        let result = try await APIClient.shared.snoozeOverdue(deltaMinutes: 60)
                        if result.tasksAffected > 0 {
                            await dismissNotifications(atOrBelowPriority: bulkSnoozeMaxPriority)
                        }

                    case NotificationAction.snoozeAllCustom:
                        // Handled by the content extension directly via .dismiss completion.
                        break

                    case UNNotificationDefaultActionIdentifier:
                        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
                        WebViewManager.shared.navigate(path: "/")

                    default:
                        if let slot = NotificationAction.parseSnoozeAllSlot(response.actionIdentifier) {
                            let result = try await APIClient.shared.snoozeOverdue(slot: slot)
                            if result.tasksAffected > 0 {
                                await dismissNotifications(atOrBelowPriority: bulkSnoozeMaxPriority)
                            }
                        }
                    }
                } catch {
                    print("[OpenTask] Summary action handler error: \(error)")
                }
                await refreshBadgeFromServer()

                completionHandler()
            }
            return
        }

        // §6 slot reminders: the slot is the unit, so there is no taskId. From
        // the lock screen only "Complete all" is offered — "Complete checked"
        // is meaningless without the expanded checklist, and the content
        // extension handles that one itself (it never forwards here).
        if categoryId == NotificationCategory.slotReminder {
            let slotId = userInfo[SlotReminderKey.slotId] as? Int ?? -1

            Task {
                do {
                    switch response.actionIdentifier {
                    case NotificationAction.completeAll:
                        let affected = try await APIClient.shared.completeSlotReminders(slotId: slotId)
                        if affected > 0 {
                            UNUserNotificationCenter.current().removeDeliveredNotifications(
                                withIdentifiers: [response.notification.request.identifier]
                            )
                        }

                    case UNNotificationDefaultActionIdentifier:
                        UNUserNotificationCenter.current().removeDeliveredNotifications(
                            withIdentifiers: [response.notification.request.identifier]
                        )
                        // Still the dashboard, not /reminders: a slot push can
                        // arrive on a build older than the web /reminders route,
                        // and the dashboard is never a 404. (`opentask://reminders`
                        // from a widget does go to /reminders — the widget and
                        // the app ship together, a push does not.)
                        WebViewManager.shared.navigate(path: "/")

                    default:
                        break
                    }
                } catch {
                    print("[OpenTask] Slot reminder action error: \(error)")
                }

                completionHandler()
            }
            return
        }

        // Individual task notifications: require taskId
        let taskId = userInfo["taskId"] as? Int

        // Belt-and-suspenders: clear this specific notification on any action
        if taskId != nil {
            UNUserNotificationCenter.current().removeDeliveredNotifications(
                withIdentifiers: [response.notification.request.identifier]
            )
        }

        guard let taskId = taskId else {
            completionHandler()
            return
        }

        Task {
            do {
                switch response.actionIdentifier {
                case NotificationAction.done:
                    try await APIClient.shared.markDone(taskId: taskId)

                case NotificationAction.snooze1hr:
                    try await APIClient.shared.snoozeNextHour(taskId: taskId)

                case NotificationAction.snoozeAll1hr:
                    let result = try await APIClient.shared.snoozeOverdue(deltaMinutes: 60, includeTaskId: taskId)
                    if result.tasksAffected > 0 {
                        await dismissNotifications(atOrBelowPriority: bulkSnoozeMaxPriority)
                    }

                case NotificationAction.snoozeCustom, NotificationAction.snoozeAllCustom:
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
                    if let slot = NotificationAction.parseSnoozeAllSlot(response.actionIdentifier) {
                        let result = try await APIClient.shared.snoozeOverdue(slot: slot, includeTaskId: taskId)
                        if result.tasksAffected > 0 {
                            await dismissNotifications(atOrBelowPriority: bulkSnoozeMaxPriority)
                        }
                    }
                }
            } catch {
                print("[OpenTask] Action handler error: \(error)")
            }
            await refreshBadgeFromServer()

            completionHandler()
        }
    }

    /// Called when a notification arrives while the app is in the foreground.
    /// Suppresses all notifications when the app is open — the user is already looking
    /// at their task list. This also prevents the remaining notifications from a cron
    /// batch from chiming after the user opens the app from the first one.
    ///
    /// `.badge` is the one option kept: in the foreground iOS applies a push's
    /// `aps.badge` only if this handler asks for it. Without it, the server's
    /// badge-only push (and the badge on an overdue alert) would be dropped
    /// whenever the app is open, and the icon would keep a stale number.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.badge])
    }
}
