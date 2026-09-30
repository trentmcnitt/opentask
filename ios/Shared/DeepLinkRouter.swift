import Foundation

/// Resolves an `opentask://` widget deep link to the web path the app loads.
///
/// The iOS and macOS apps are WKWebViews over the PWA with no native routes,
/// so every link becomes a path on the configured server. Both apps'
/// `handleWidgetLink` are a guard on this plus `WebViewManager.navigate(path:)`
/// — one table, so the two can't drift (they used to be byte-parallel copies).
/// The widget extension's `WidgetLink` enum (`ios/OpenTaskWidgets/WidgetTheme.swift`)
/// emits the same `opentask://` links on both platforms.
///
/// `today` and anything unrecognized fall through to the dashboard (`/`).
/// Foundation only, in Shared/, so `OpenTaskLogicTests` (`DeepLinkRouterTests`)
/// pins every row.
enum DeepLinkRouter {
    /// The web path a task NOTIFICATION's body tap loads (phone and Mac,
    /// `WebViewManager.navigateToTask`): the bare `/?task=<id>`, the same URL
    /// the server's Web Push notifications carry (`overdue-checker.ts`,
    /// `enrichment-notify.ts`). The dashboard brings that task's row into view
    /// and selects it — no editor, no sheet; a reminder goes on to
    /// `/reminders?reminder=<id>`, and a task that is done or gone gets a toast.
    ///
    /// Kept bare rather than flagged (`&select=1`) so the builds already
    /// installed, which load exactly this URL, got the new behavior from the
    /// server alone.
    static func notificationTaskPath(taskId: Int) -> String {
        "/?task=\(taskId)"
    }

    /// The web path for a widget link, or nil when the URL isn't an
    /// `opentask://` link at all (the app then does nothing).
    static func webPath(for url: URL) -> String? {
        guard url.scheme == "opentask" else { return nil }
        let lastId = url.pathComponents.last.flatMap(Int.init)

        switch url.host {
        case "task":
            // `&highlight=1`: a widget tap means "bring it into view and
            // flash it", the same thing a reminder tap means (see `reminder`
            // below). A NOTIFICATION tap on a task (`notificationTaskPath`
            // above, loaded by both apps' `navigateToTask`) is the bare
            // `/?task=<id>`, which also brings the row into view but SELECTS
            // it, so the action bar is up for the thing the notification was
            // about. Neither opens the editor. See `DashboardClient.tsx`'s
            // `?task=` effect for the other half of this.
            if let id = lastId { return "/?task=\(id)&highlight=1" }
            return "/"
        case "reminder":
            // A reminder opens ON the Reminders surface, and opens nothing:
            // `?reminder=<id>` brings that row into view and highlights it.
            // Tapping a reminder means "show me that one" — routing it through
            // `task` instead put it on the dashboard with an editor open, which
            // is the wrong tab and more than was asked for.
            if let id = lastId { return "/reminders?reminder=\(id)" }
            return "/reminders"
        case "reminders":
            // `/slot/<id>` (2026-09-23, item 2) scopes the header title Link
            // to bring that slot into view — see `WidgetLink.reminders(slot:)`.
            // Bare `reminders` (2×2, Lock Screen, "+N more"/background tap)
            // still opens the surface unscoped.
            let parts = url.pathComponents
            if parts.count >= 3, parts[parts.count - 2] == "slot", let slotId = lastId {
                return "/reminders?slot=\(slotId)"
            }
            // A quota PROMPT row (`/prompt/<key>`, `PromptDeepLink`) opens
            // ON the Reminders surface too — it was tapped on the Reminders
            // widget — with that exact row (by `prompt_key`) highlighted.
            if let promptKey = PromptDeepLink.promptKey(from: url) {
                return PromptDeepLink.webPath(promptKey: promptKey)
            }
            return "/reminders"
        case "project":
            // A project-scoped Tasks header link (2026-09-23, item 2) — see
            // `WidgetLink.project(_:)`.
            if let id = lastId { return "/?project=\(id)" }
            return "/"
        case "quota":
            // A quota opens ON the Quotas surface, and opens nothing — same
            // shape as `reminder` above. Tapping a quota from Track means
            // "show me that one", not "open its full detail page", which is
            // where `task/<id>` would send a tracked id instead.
            if let id = lastId { return "/quotas?quota=\(id)" }
            return "/quotas"
        case "quotas":
            return "/quotas"
        case "overdue":
            // The Tasks widget's header on its Overdue page (2026-09-25) —
            // the dashboard with its Overdue chip on. See `WidgetLink.overdue`.
            return "/?filter=overdue"
        default:
            return "/"
        }
    }
}
