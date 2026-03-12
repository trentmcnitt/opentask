import UIKit
import WebKit

/// Centralized handler for Home Screen Quick Actions.
///
/// Called from two sites:
/// - AppDelegate.handleShortcutItem (cold launch snooze via scenePhase observer)
/// - SceneDelegateInterceptor (warm launch via performActionFor)
///
/// The add-task action tries JS injection first (instant, no page reload);
/// falls back to full URL navigation if the WebView's JS context isn't ready
/// (can happen when resuming from background suspension).
enum QuickActionHandler {

    // MARK: - Action Type Constants

    static let snooze1hr = "io.mcnitt.opentask.snooze-1hr"
    static let snooze2hr = "io.mcnitt.opentask.snooze-2hr"
    static let snoozeTomorrow = "io.mcnitt.opentask.snooze-tomorrow"
    static let addTask = "io.mcnitt.opentask.add-task"

    // MARK: - Dispatch

    static func handle(_ shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        print("[OpenTask] Quick action: \(shortcutItem.type)")

        switch shortcutItem.type {
        case snooze1hr:
            Task {
                do {
                    let result = try await APIClient.shared.snoozeOverdue(deltaMinutes: 60)
                    print("[OpenTask] Quick action: snoozed \(result.tasksAffected) tasks +1hr")
                } catch {
                    print("[OpenTask] Quick action snooze +1hr error: \(error)")
                }
                completionHandler(true)
            }

        case snooze2hr:
            Task {
                do {
                    let result = try await APIClient.shared.snoozeOverdue(deltaMinutes: 120)
                    print("[OpenTask] Quick action: snoozed \(result.tasksAffected) tasks +2hr")
                } catch {
                    print("[OpenTask] Quick action snooze +2hr error: \(error)")
                }
                completionHandler(true)
            }

        case snoozeTomorrow:
            Task {
                do {
                    let result = try await APIClient.shared.snoozeOverdueDefault()
                    print("[OpenTask] Quick action: snoozed \(result.tasksAffected) tasks to tomorrow")
                } catch {
                    print("[OpenTask] Quick action snooze tomorrow error: \(error)")
                }
                completionHandler(true)
            }

        case addTask:
            openAddTaskPanel()
            completionHandler(true)

        default:
            completionHandler(false)
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
