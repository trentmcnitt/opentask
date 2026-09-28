import OSLog
import UIKit
import WidgetKit

/// Centralized handler for Home Screen Quick Actions, called from
/// `QuickActionSceneDelegate` on both cold and warm launch.
///
/// The snooze actions sweep the overdue set (`POST /api/tasks/bulk/snooze-overdue`,
/// the same call as the watch and the notification actions), then refresh the
/// page, which is already on screen — iOS always opens the app for a Home
/// Screen quick action, so the page is where the answer goes: the result is
/// handed to it (`WebViewManager.deliverSnoozeResult`) and it shows the same
/// "Snoozed N tasks · Undo" toast its own snooze does (Trent, 2026-09-28: the
/// toast "would have acted as a notification and also given me a chance to
/// undo"). A local notification was tried first and dropped — pointless with
/// the app already open.
enum QuickActionHandler {

    static let log = Logger(subsystem: "io.mcnitt.opentask", category: "quick-actions")

    // MARK: - Action Type Constants

    static let snooze1hr = "io.mcnitt.opentask.snooze-1hr"
    static let snoozeNextPeriod = "io.mcnitt.opentask.snooze-next-period"
    static let snooze2hr = "io.mcnitt.opentask.snooze-2hr"
    static let snoozeTomorrow = "io.mcnitt.opentask.snooze-tomorrow"

    // MARK: - Dispatch

    static func handle(_ shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        switch shortcutItem.type {
        case snooze1hr:
            snooze(label: "+1 hour", completionHandler: completionHandler) {
                try await APIClient.shared.snoozeOverdue(deltaMinutes: 60)
            }

        case snoozeNextPeriod:
            snooze(label: "next period", completionHandler: completionHandler) {
                try await APIClient.shared.snoozeOverdue(slot: "next")
            }

        case snooze2hr:
            snooze(label: "+2 hours", completionHandler: completionHandler) {
                try await APIClient.shared.snoozeOverdue(deltaMinutes: 120)
            }

        case snoozeTomorrow:
            // It used to send an empty body, i.e. the user's default snooze
            // option — +1 hour for most users, not tomorrow (2026-09-28).
            snooze(label: "tomorrow", completionHandler: completionHandler) {
                try await APIClient.shared.snoozeOverdueTomorrow()
            }

        default:
            log.error("Unknown quick action: \(shortcutItem.type, privacy: .public)")
            completionHandler(false)
        }
    }

    // MARK: - Snooze

    /// iOS's completion handler is answered at once, on the main thread
    /// where it was delivered: it only reports whether the action was
    /// handled, and UIKit aborts when it is called from a background
    /// executor — which the first cut did, after the network call
    /// (crash, 2026-09-28: `_UIWindowSceneSendShortcutItemCallbackForWindowScene`
    /// → NSAssertionHandler).
    private static func snooze(
        label: String,
        completionHandler: @escaping (Bool) -> Void,
        _ call: @escaping () async throws -> APIClient.BulkSnoozeResult
    ) {
        completionHandler(true)
        Task {
            do {
                let result = try await call()
                log.notice("Snoozed \(result.tasksAffected) overdue (\(label, privacy: .public))")
                // The wire field names, so the page reads it like the API's.
                let json = "{\"tasks_affected\":\(result.tasksAffected),\"snoozed_high\":\(result.snoozedHigh),"
                    + "\"skipped_high\":\(result.skippedHigh),\"skipped_urgent\":\(result.skippedOnPriority)}"
                await MainActor.run { WebViewManager.shared.deliverSnoozeResult(json: json) }
            } catch {
                log.error("Snooze (\(label, privacy: .public)) failed: \(String(describing: error), privacy: .public)")
                // Say so on the page — a silent failure is what made the
                // first report ("it didn't do anything") hard to read.
                await MainActor.run { WebViewManager.shared.deliverSnoozeResult(json: "{\"error\":true}") }
            }
            await MainActor.run {
                // The page on screen still shows the old overdue list.
                WebViewManager.shared.webView?.evaluateJavaScript(
                    "window.dispatchEvent(new CustomEvent('opentask-app-active'))"
                )
                WidgetCenter.shared.reloadAllTimelines()
            }
        }
    }
}
