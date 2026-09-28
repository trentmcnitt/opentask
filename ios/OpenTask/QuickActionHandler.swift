import OSLog
import UIKit
import UserNotifications
import WebKit
import WidgetKit

/// Centralized handler for Home Screen Quick Actions, called from
/// `QuickActionSceneDelegate` on both cold and warm launch.
///
/// The snooze actions sweep the overdue set (`POST /api/tasks/bulk/snooze-overdue`,
/// the same call as the watch and the notification actions), then say what
/// happened: a local notification with the server's real count (Trent,
/// 2026-09-28: "it'd be nice if it … just sent me a notification saying
/// everything was snoozed"), and a refresh of the page, which is already on
/// screen — iOS always opens the app for a Home Screen quick action.
///
/// The add-task action tries JS injection first (instant, no page reload);
/// falls back to full URL navigation if the WebView's JS context isn't ready
/// (can happen when resuming from background suspension).
enum QuickActionHandler {

    static let log = Logger(subsystem: "io.mcnitt.opentask", category: "quick-actions")

    /// Local notifications with this category are shown even while the app is
    /// in the foreground — see `AppDelegate.userNotificationCenter(_:willPresent:)`.
    static let resultCategory = "QUICK_ACTION_RESULT"

    // MARK: - Action Type Constants

    static let snooze1hr = "io.mcnitt.opentask.snooze-1hr"
    static let snooze2hr = "io.mcnitt.opentask.snooze-2hr"
    static let snoozeTomorrow = "io.mcnitt.opentask.snooze-tomorrow"
    static let addTask = "io.mcnitt.opentask.add-task"

    // MARK: - Dispatch

    static func handle(_ shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        switch shortcutItem.type {
        case snooze1hr:
            snooze(label: "+1 hour", completionHandler: completionHandler) {
                try await APIClient.shared.snoozeOverdue(deltaMinutes: 60)
            }

        case snooze2hr:
            snooze(label: "+2 hours", completionHandler: completionHandler) {
                try await APIClient.shared.snoozeOverdue(deltaMinutes: 120)
            }

        case snoozeTomorrow:
            snooze(label: "your default snooze", completionHandler: completionHandler) {
                try await APIClient.shared.snoozeOverdueDefault()
            }

        case addTask:
            openAddTaskPanel()
            completionHandler(true)

        default:
            log.error("Unknown quick action: \(shortcutItem.type, privacy: .public)")
            completionHandler(false)
        }
    }

    // MARK: - Snooze

    private static func snooze(
        label: String,
        completionHandler: @escaping (Bool) -> Void,
        _ call: @escaping () async throws -> APIClient.BulkSnoozeResult
    ) {
        Task {
            let body: String
            do {
                let result = try await call()
                log.notice("Snoozed \(result.tasksAffected) overdue (\(label, privacy: .public))")
                body = summary(result, label: label)
            } catch {
                log.error("Snooze (\(label, privacy: .public)) failed: \(String(describing: error), privacy: .public)")
                body = "Couldn't snooze — \(error.localizedDescription)"
            }
            await postResult(body)
            await MainActor.run {
                // The page on screen still shows the old overdue list.
                WebViewManager.shared.webView?.evaluateJavaScript(
                    "window.dispatchEvent(new CustomEvent('opentask-app-active'))"
                )
            }
            WidgetCenter.shared.reloadAllTimelines()
            completionHandler(true)
        }
    }

    /// "Snoozed 12 overdue tasks · +1 hour", plus what stayed behind and why.
    private static func summary(_ result: APIClient.BulkSnoozeResult, label: String) -> String {
        let n = result.tasksAffected
        var text = n == 0
            ? "Nothing to snooze"
            : "Snoozed \(n) overdue \(n == 1 ? "task" : "tasks") · \(label)"
        if result.skippedHigh > 0 {
            text += " · \(result.skippedHigh) High left"
        }
        if result.skippedUrgent > 0 {
            text += " · \(result.skippedUrgent) Urgent left"
        }
        return text
    }

    private static func postResult(_ body: String) async {
        let content = UNMutableNotificationContent()
        content.title = "OpenTask"
        content.body = body
        content.categoryIdentifier = resultCategory
        let request = UNNotificationRequest(identifier: "quick-action-result", content: content, trigger: nil)
        do {
            try await UNUserNotificationCenter.current().add(request)
        } catch {
            log.error("Result notification failed: \(String(describing: error), privacy: .public)")
        }
    }

    // MARK: - Add Task

    /// Open the Add Task panel via JS injection with URL navigation fallback.
    static func openAddTaskPanel() {
        guard let webView = WebViewManager.shared.webView else {
            // WebView doesn't exist — store pending path for when it's created
            WebViewManager.shared.navigate(path: "/?action=create")
            return
        }

        DispatchQueue.main.async {
            let js = "window.dispatchEvent(new CustomEvent('open-add-form'))"
            webView.evaluateJavaScript(js) { _, error in
                if let error = error {
                    print("[OpenTask] JS inject failed, falling back to URL nav: \(error)")
                    let serverURL = AppConfig.shared.serverURL
                    if let url = URL(string: serverURL + "/?action=create") {
                        webView.load(URLRequest(url: url))
                    }
                }
            }
        }
    }
}
