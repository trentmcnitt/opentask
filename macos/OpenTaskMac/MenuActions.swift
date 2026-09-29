import AppKit

/// What the menu bar items actually do.
///
/// Kept out of the `Commands` struct so the same action can be triggered from
/// anywhere later (a Dock menu, a global hotkey) without going through SwiftUI,
/// and so the menu definition stays a list of titles and shortcuts.
///
/// The three Snooze All items are the Mac's version of the iPhone's Home
/// Screen quick actions (`ios/OpenTask/QuickActionHandler.swift`) and call the
/// same endpoints, so the P3/P4 rule is the server's either way: Urgent tasks
/// are never bulk-snoozed, and High tasks only once nothing lower is left
/// overdue, because their due dates are real deadlines (docs/TASK-MODEL.md).
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

    /// "To Tomorrow": tomorrow at the user's morning time (`tomorrow: true`),
    /// not a hardcoded 24 hours — the server owns what tomorrow morning means
    /// for this account, and this is the same call the iPhone's "Snooze All
    /// to Tomorrow" Home Screen quick action makes. (It used to send an empty
    /// body, which the server reads as the user's DEFAULT snooze — whatever
    /// that is set to, not necessarily tomorrow.)
    static func snoozeAllToTomorrow(label: String) {
        run(label: label) {
            try await APIClient.shared.snoozeOverdueTomorrow()
        }
    }

    /// Runs a bulk snooze and reports the outcome.
    ///
    /// Nothing is reloaded on success: the server emits a sync event and the
    /// open page moves the rows itself over SSE, which keeps scroll position
    /// and any open editor. Only the two cases the user cannot see get a
    /// dialog — "nothing happened" and "it failed" — because a menu command
    /// that silently does nothing is indistinguishable from a broken one.
    ///
    /// The Dock badge is re-read from the server (`refreshBadgeFromServer`,
    /// the same count the notification actions use). It used to be set to
    /// the sweep's Urgent-only skipped count, which is not the overdue total:
    /// it left out every High task the sweep skipped.
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
                print("[OpenTask] \(label): snoozed \(result.tasksAffected), skipped \(result.skippedHigh) high, \(result.skippedUrgent) urgent")
                await dismissNotificationsAfterSweep(result)
                await refreshBadgeFromServer()
                if result.tasksAffected == 0 {
                    alert(
                        style: .informational,
                        title: "Nothing to snooze",
                        message: nothingToSnoozeMessage(result)
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

    /// Why a sweep moved nothing. Normally that means nothing was overdue,
    /// but High tasks can be left behind too: the relative (+1hr/+2hr) items
    /// count a dateless P0-P2 task as "lower and still left" for the server's
    /// High-tier rule even though a relative snooze can't move it
    /// (`filterForBulkSnooze` in `src/core/tasks/bulk.ts`). So both skipped
    /// tiers are named, not just Urgent.
    private static func nothingToSnoozeMessage(_ result: APIClient.BulkSnoozeResult) -> String {
        var parts: [String] = []
        var total = 0
        for line in result.summaryLines {
            switch line {
            case .includedHigh: break  // zero here: nothing moved
            case .highStillOverdue(let n):
                parts.append("\(n) High")
                total += n
            case .urgentStillOverdue(let n):
                parts.append("\(n) Urgent")
                total += n
            }
        }
        guard !parts.isEmpty else { return "No overdue tasks." }
        return "\(parts.joined(separator: " and ")) task\(total == 1 ? " is" : "s are") still overdue. "
            + "Urgent tasks are never bulk-snoozed, and High tasks only once nothing lower is left."
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
