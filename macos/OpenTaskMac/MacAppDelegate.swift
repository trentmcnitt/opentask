import AppKit
import UserNotifications

/// APNs registration, notification permission, and notification action handling.
///
/// The macOS counterpart of `ios/OpenTask/AppDelegate.swift`. The notification
/// categories and the action semantics are shared code
/// (`ios/Shared/NotificationConstants.swift`), so Done / +1hr / All +1hr /
/// Complete all mean exactly what they mean on the phone and the watch.
///
/// Three deliberate differences from the iPhone app, each explained at its
/// call site below: no `dismissAllNotifications()` on activation, a narrower
/// rule for suppressing foreground banners, and no `.criticalAlert` in the
/// authorization request.
final class MacAppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
        // This app and the code it shares with the iPhone app diagnose
        // themselves with `print()`, and on macOS stdout is a pipe, not a
        // console — so those lines sit in a 4 KB buffer until the process
        // exits, which for a GUI app means "never, in practice". Line
        // buffering makes them appear as they happen when the app is launched
        // from a terminal, which is how anyone debugs it (see macos/README.md).
        setvbuf(stdout, nil, _IOLBF, 0)

        // Re-save Keychain items with kSecAttrAccessibleAfterFirstUnlock so a
        // notification action fired before the first unlock can still read the
        // token. Harmless when they are already correct.
        KeychainHelper.migrateAccessibility(keys: ["serverURL", "bearerToken"])

        UNUserNotificationCenter.current().delegate = self
        registerNotificationCategories()
        requestNotificationPermission()

        print("[OpenTask] Launched — configured: \(AppConfig.shared.isConfigured), "
            + "server: \(AppConfig.shared.serverURL.isEmpty ? "(none)" : AppConfig.shared.serverURL), "
            + "token in Keychain: \(KeychainHelper.read(key: "bearerToken") != nil)")

        // Worth a line in the log every launch: "notifications don't work" has
        // three unrelated causes (permission, entitlement, server-side device
        // registration) and this rules the first one in or out immediately.
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            print("[OpenTask] Notification authorization: \(settings.authorizationStatus.rawValue) "
                + "(0=notDetermined 1=denied 2=authorized 3=provisional)")
        }
    }

    /// A notification client with no window is still doing its job, so closing
    /// the window must not quit the app — it parks it in the Dock, and a
    /// notification tap or a Dock click brings it back.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// Dock click with every window closed: SwiftUI restores the `Window`
    /// scene, and returning true is what asks it to.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows {
            WebViewManager.shared.showWindow()
        }
        return true
    }

    /// Clear this Mac's delivered notifications when the app comes forward —
    /// the user is looking at the list, so the banners have served their
    /// purpose.
    ///
    /// Unlike the iPhone app this does NOT call
    /// `APIClient.dismissAllNotifications()`. That endpoint clears delivered
    /// notifications on every OTHER device too, and on a Mac "became active"
    /// fires every time the user clicks back into the window — it would wipe
    /// the phone's notifications dozens of times a day. (The same call is
    /// already flagged as a bug on iOS in the 2026-09-15 feasibility notes;
    /// this app simply does not inherit it.)
    func applicationDidBecomeActive(_ notification: Notification) {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        updateBadge(0)
    }

    // MARK: - Permission and registration

    /// No `.criticalAlert`: that option needs a per-App-ID entitlement Apple
    /// grants by request, and asking for it here would fail provisioning for a
    /// capability this app does not use.
    private func requestNotificationPermission() {
        Task { @MainActor in
            do {
                let granted = try await UNUserNotificationCenter.current()
                    .requestAuthorization(options: [.alert, .badge, .sound])
                print("[OpenTask] Notification permission granted: \(granted)")
                guard granted else { return }
                NSApplication.shared.registerForRemoteNotifications()
            } catch {
                print("[OpenTask] Notification permission error: \(error)")
            }
        }
    }

    func application(
        _ application: NSApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        print("[OpenTask] APNs registered, token length \(token.count)")
        #if DEBUG
        print("[OpenTask] APNs token: \(token)")
        #endif

        AppConfig.shared.deviceToken = token

        // Hand the token to a page that may already be loaded. The web app
        // registers it with the server under the session cookie, so push
        // follows the logged-in user rather than the Bearer token's owner.
        // The CustomEvent wakes PreferencesProvider if it mounted first.
        Task { @MainActor in
            WebViewManager.shared.evaluate(
                WebViewHost.Coordinator.deviceInfoJS(token: token)
                    + "window.dispatchEvent(new CustomEvent('opentask-device-token'));"
            )
        }
    }

    /// The expected failure while this app ships without `aps-environment`:
    /// "no valid aps-environment entitlement string found". Everything else in
    /// the app keeps working; only push is dead. See `macos/README.md`.
    func application(
        _ application: NSApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        print("[OpenTask] APNs registration failed: \(error.localizedDescription)")
    }

    // MARK: - Silent push

    /// Server-initiated housekeeping: badge counts and dismissals when a task
    /// is handled somewhere else. macOS hands these to a running app with no
    /// completion handler — there is no background-fetch contract to satisfy.
    func application(_ application: NSApplication, didReceiveRemoteNotification userInfo: [String: Any]) {
        guard let type = userInfo["type"] as? String else { return }
        let center = UNUserNotificationCenter.current()

        switch type {
        case "badge-update":
            if let badge = userInfo["badge"] as? Int {
                updateBadge(badge)
                print("[OpenTask] Badge updated to \(badge)")
            }

        case "dismiss-all":
            center.removeAllDeliveredNotifications()
            print("[OpenTask] Dismiss-all: cleared all delivered notifications")

        case "dismiss":
            guard let taskIds = userInfo["taskIds"] as? [Int], !taskIds.isEmpty else { return }
            center.getDeliveredNotifications { notifications in
                let idsToRemove = notifications
                    .filter { notification in
                        guard let id = notification.request.content.userInfo["taskId"] as? Int
                        else { return false }
                        return taskIds.contains(id)
                    }
                    .map(\.request.identifier)

                guard !idsToRemove.isEmpty else { return }
                center.removeDeliveredNotifications(withIdentifiers: idsToRemove)
                print("[OpenTask] Dismissed \(idsToRemove.count) notifications for tasks \(taskIds)")
            }

        default:
            break
        }
    }

    // MARK: - Notification actions

    /// Same three categories as the phone: a summary (bulk only), a §6 time
    /// slot (no taskId — the slot is the unit), and an individual task.
    ///
    /// The custom-snooze actions are not registered on any category here: they
    /// are served by a notification content extension, and this app does not
    /// have one yet. If one is added later, its actions land in this switch.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let categoryId = response.notification.request.content.categoryIdentifier
        let identifier = response.notification.request.identifier

        if let type = userInfo["type"] as? String, type == "dismiss" {
            completionHandler()
            return
        }

        switch categoryId {
        case NotificationCategory.taskSummary:
            handleSummaryAction(response, identifier: identifier, completionHandler: completionHandler)
        case NotificationCategory.slotReminder:
            handleSlotAction(response, userInfo: userInfo, identifier: identifier, completionHandler: completionHandler)
        default:
            handleTaskAction(response, userInfo: userInfo, identifier: identifier, completionHandler: completionHandler)
        }
    }

    private func handleSummaryAction(
        _ response: UNNotificationResponse,
        identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [identifier])

        Task {
            do {
                switch response.actionIdentifier {
                case NotificationAction.snoozeAll1hr:
                    let result = try await APIClient.shared.snoozeOverdue(deltaMinutes: 60)
                    if result.tasksAffected > 0 {
                        await dismissNotifications(atOrBelowPriority: bulkSnoozeMaxPriority)
                    }
                    updateBadge(result.skippedUrgent)

                case UNNotificationDefaultActionIdentifier:
                    UNUserNotificationCenter.current().removeAllDeliveredNotifications()
                    await WebViewManager.shared.navigate(path: "/")

                default:
                    break
                }
            } catch {
                print("[OpenTask] Summary action handler error: \(error)")
            }
            completionHandler()
        }
    }

    private func handleSlotAction(
        _ response: UNNotificationResponse,
        userInfo: [AnyHashable: Any],
        identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        let slotId = userInfo[SlotReminderKey.slotId] as? Int ?? -1

        Task {
            do {
                switch response.actionIdentifier {
                case NotificationAction.completeAll:
                    let affected = try await APIClient.shared.completeSlotReminders(slotId: slotId)
                    if affected > 0 {
                        UNUserNotificationCenter.current()
                            .removeDeliveredNotifications(withIdentifiers: [identifier])
                    }

                case UNNotificationDefaultActionIdentifier:
                    UNUserNotificationCenter.current()
                        .removeDeliveredNotifications(withIdentifiers: [identifier])
                    // The dashboard, not /reminders: a slot push can arrive on
                    // a build older than the web /reminders route, and the
                    // dashboard is never a 404.
                    await WebViewManager.shared.navigate(path: "/")

                default:
                    break
                }
            } catch {
                print("[OpenTask] Slot reminder action error: \(error)")
            }
            completionHandler()
        }
    }

    private func handleTaskAction(
        _ response: UNNotificationResponse,
        userInfo: [AnyHashable: Any],
        identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        let taskId = userInfo["taskId"] as? Int
        let overdueCount = userInfo["overdueCount"] as? Int

        if taskId != nil {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [identifier])
        }

        guard let taskId else {
            completionHandler()
            return
        }

        Task {
            do {
                switch response.actionIdentifier {
                case NotificationAction.done:
                    try await APIClient.shared.markDone(taskId: taskId)
                    if let overdueCount { updateBadge(overdueCount - 1) }

                case NotificationAction.snooze1hr:
                    try await APIClient.shared.snoozeNextHour(taskId: taskId)
                    if let overdueCount { updateBadge(overdueCount - 1) }

                case NotificationAction.snoozeAll1hr:
                    let result = try await APIClient.shared.snoozeOverdue(
                        deltaMinutes: 60,
                        includeTaskId: taskId
                    )
                    if result.tasksAffected > 0 {
                        await dismissNotifications(atOrBelowPriority: bulkSnoozeMaxPriority)
                    }
                    updateBadge(result.skippedUrgent)

                case UNNotificationDefaultActionIdentifier:
                    UNUserNotificationCenter.current().removeAllDeliveredNotifications()
                    await WebViewManager.shared.navigateToTask(taskId)

                default:
                    break
                }
            } catch {
                print("[OpenTask] Action handler error: \(error)")
            }
            completionHandler()
        }
    }

    /// The iPhone suppresses every notification while the app is foreground —
    /// on a phone, "app open" means the task list is the only thing on screen.
    /// That is not true of a Mac: an OpenTask window can be open and active
    /// behind three others, or on another Space entirely. So the banner is
    /// suppressed only when the app is active AND has a window actually on
    /// screen; otherwise it is delivered, because the user is demonstrably
    /// looking at something else.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let hasVisibleWindow = NSApp.windows.contains { $0.isVisible && !$0.isMiniaturized }
        if NSApp.isActive && hasVisibleWindow {
            completionHandler([])
        } else {
            completionHandler([.banner, .list, .sound])
        }
    }
}
