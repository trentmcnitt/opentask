import AppKit

/// What the menu bar items actually do.
///
/// Kept out of the `Commands` struct so the same action can be triggered from
/// anywhere later (a Dock menu, a global hotkey) without going through SwiftUI,
/// and so the menu definition stays a list of titles and shortcuts.
///
/// The three Snooze All items are the Mac's version of the iPhone's Home
/// Screen quick actions (`ios/OpenTask/QuickActionHandler.swift`) and call the
/// same endpoints, so the P3/P4 rule is the server's either way: High and
/// Urgent tasks are never bulk-snoozed, because their due dates are real
/// deadlines.
@MainActor
enum MenuActions {

    // MARK: - Navigation

    /// Open the add-task panel. Tries a JS event first — instant, keeps the
    /// page and its scroll position — and falls back to a URL navigation if
    /// the page has no JS context yet (cold launch, or an error view).
    static func newTask() {
        print("[OpenTask] Menu: New Task")
        guard let webView = WebViewManager.shared.webView else {
            WebViewManager.shared.navigate(path: "/?action=create")
            return
        }
        WebViewManager.shared.showWindow()
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('open-add-form'))") { _, error in
            if let error {
                print("[OpenTask] JS inject failed, falling back to URL nav: \(error)")
                WebViewManager.shared.navigate(path: "/?action=create")
            }
        }
    }

    static func reload() {
        print("[OpenTask] Menu: Reload")
        WebViewManager.shared.reload()
    }

    // MARK: - Bulk snooze

    /// `+1hr` / `+2hr`: a relative bulk snooze of every overdue task.
    static func snoozeAll(deltaMinutes: Int, label: String) {
        run(label: label) {
            try await APIClient.shared.snoozeOverdue(deltaMinutes: deltaMinutes)
        }
    }

    /// "To Tomorrow" is the user's *default* snooze, not a hardcoded 24 hours —
    /// the server owns what tomorrow means for this account, exactly as the
    /// iPhone's quick action does.
    static func snoozeAllToDefault(label: String) {
        run(label: label) {
            try await APIClient.shared.snoozeOverdueDefault()
        }
    }

    /// Runs a bulk snooze and reports the outcome.
    ///
    /// Nothing is reloaded on success: the server emits a sync event and the
    /// open page moves the rows itself over SSE, which keeps scroll position
    /// and any open editor. Only the two cases the user cannot see get a
    /// dialog — "nothing happened" and "it failed" — because a menu command
    /// that silently does nothing is indistinguishable from a broken one.
    private static func run(
        label: String,
        _ call: @escaping () async throws -> APIClient.BulkSnoozeResult
    ) {
        print("[OpenTask] Menu: \(label)")
        guard APIClient.shared.isConfigured else {
            alert(
                style: .warning,
                title: "Not connected yet",
                message: "Log in to OpenTask in the window first — the app provisions its access token from that session."
            )
            return
        }

        Task {
            do {
                let result = try await call()
                print("[OpenTask] \(label): snoozed \(result.tasksAffected), skipped \(result.skippedUrgent) urgent")
                if result.tasksAffected > 0 {
                    await dismissNotifications(atOrBelowPriority: bulkSnoozeMaxPriority)
                }
                updateBadge(result.skippedUrgent)
                if result.tasksAffected == 0 {
                    alert(
                        style: .informational,
                        title: "Nothing to snooze",
                        message: result.skippedUrgent > 0
                            ? "\(result.skippedUrgent) urgent task\(result.skippedUrgent == 1 ? " is" : "s are") overdue. Urgent tasks are never bulk-snoozed."
                            : "No overdue tasks."
                    )
                }
            } catch {
                print("[OpenTask] \(label) failed: \(error)")
                alert(
                    style: .warning,
                    title: "\(label) failed",
                    message: error.localizedDescription
                )
            }
        }
    }

    private static func alert(style: NSAlert.Style, title: String, message: String) {
        let alert = NSAlert()
        alert.alertStyle = style
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        NSApp.activate()
        alert.runModal()
    }
}
