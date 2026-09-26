import SwiftUI
import WidgetKit

@main
struct OpenTaskApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                if AppConfig.shared.isConfigured {
                    ContentView()
                } else {
                    SetupView()
                }
            }
            // `onOpenURL` is a View modifier, not a Scene modifier — it has to
            // sit inside WindowGroup's content or it doesn't resolve.
            .onOpenURL { url in
                handleWidgetLink(url)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // Leaving the app refreshes the widgets too (Trent, 2026-09-23: "I
            // uncompleted a couple of reminders… swiped back to the home screen
            // and it did not update"). Whatever he just did in the app is
            // what the Home Screen should show; a reload asked for by the app
            // as it leaves doesn't wait on the 30-minute timeline or on a
            // widget push arriving.
            if phase == .background {
                WidgetCenter.shared.reloadAllTimelines()
            }
            if phase == .active {
                // No `reloadAllTimelines()` here (removed 2026-09-24). It
                // reloaded all three widget kinds — each a network fetch — on
                // every activation, while the user is IN the app and can't
                // see a widget. What keeps them current instead:
                //  - the `.background` reload above, fired as the user
                //    leaves, i.e. exactly when the Home Screen shows again,
                //    carrying whatever changed in the app (mutations happen
                //    in the web view, so native can't tell "data changed"
                //    any more precisely than "the user was here");
                //  - the server's WidgetKit push on every mutation from any
                //    device (iOS 26, docs/NOTIFICATIONS.md);
                //  - each widget intent's own reload, and the timeline.
                // Side effect to know about: Quotas' Takeback mode used to be
                // cleared by this app-foreground reload; it is now cleared by
                // the leave-the-app reload instead (`TrackProvider.currentEntry`
                // clears it on any timeline built outside a recent widget tap).

                // Install interceptor for warm-launch quick actions.
                // SwiftUI replaces the scene delegate set in configurationForConnecting
                // with its own internal delegate, so performActionFor never fires.
                // The interceptor wraps SwiftUI's delegate and catches performActionFor
                // while forwarding everything else. Re-check each activation in case
                // SwiftUI resets the delegate.
                if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                   !(windowScene.delegate is SceneDelegateInterceptor) {
                    let interceptor = SceneDelegateInterceptor(wrapping: windowScene.delegate as AnyObject?)
                    windowScene.delegate = interceptor
                    SceneDelegateInterceptor.instance = interceptor
                }

                // Process deferred quick action from cold launch. For snooze actions,
                // APIClient reads credentials from Keychain directly (no WebView needed).
                // For add-task, the pending path was already set in configurationForConnecting.
                if AppConfig.shared.isConfigured, let item = appDelegate.savedShortcutItem {
                    appDelegate.savedShortcutItem = nil
                    appDelegate.handleShortcutItem(item, completionHandler: { _ in })
                }
            }
        }
    }

    /// Resolve an `opentask://` deep link from the widget extension to a web path.
    ///
    /// The app is a WKWebView over the PWA and has no native routes, so every
    /// link becomes a path on the configured server. `today` and anything
    /// unrecognized fall through to the dashboard.
    private func handleWidgetLink(_ url: URL) {
        guard url.scheme == "opentask" else { return }

        switch url.host {
        case "task":
            // `&highlight=1`, not `navigateToTask(id)`: a widget tap means
            // "bring it into view", the same thing a reminder tap means (see
            // `reminder` below) — not "open the editor". A NOTIFICATION tap on
            // a task (`AppDelegate.handleNotificationAction`) is the one place
            // that still wants the editor, and it calls `navigateToTask`
            // directly, bypassing this switch entirely — so the flag is the
            // only thing that tells `DashboardClient`'s identical `/?task=`
            // apart from the two callers. See `DashboardClient.tsx`'s
            // `?task=` effect for the other half of this.
            let id = url.pathComponents.last.flatMap(Int.init)
            if let id {
                WebViewManager.shared.navigate(path: "/?task=\(id)&highlight=1")
            } else {
                WebViewManager.shared.navigate(path: "/")
            }
        case "reminder":
            // A reminder opens ON the Reminders surface, and opens nothing:
            // `?reminder=<id>` brings that row into view and highlights it.
            // Tapping a reminder means "show me that one" — routing it through
            // `task` instead put it on the dashboard with an editor open, which
            // is the wrong tab and more than was asked for.
            if let id = url.pathComponents.last.flatMap(Int.init) {
                WebViewManager.shared.navigate(path: "/reminders?reminder=\(id)")
            } else {
                WebViewManager.shared.navigate(path: "/reminders")
            }
        case "reminders":
            // `/slot/<id>` (2026-09-23, item 2) scopes the header title Link
            // to bring that slot into view — see `WidgetLink.reminders(slot:)`.
            // Bare `reminders` (2×2, Lock Screen, "+N more"/background tap)
            // still opens the surface unscoped.
            if url.pathComponents.count >= 3, url.pathComponents[url.pathComponents.count - 2] == "slot",
               let slotId = url.pathComponents.last.flatMap(Int.init) {
                WebViewManager.shared.navigate(path: "/reminders?slot=\(slotId)")
            } else {
                WebViewManager.shared.navigate(path: "/reminders")
            }
        case "project":
            // A project-scoped Tasks header link (2026-09-23, item 2) — see
            // `WidgetLink.project(_:)`.
            if let id = url.pathComponents.last.flatMap(Int.init) {
                WebViewManager.shared.navigate(path: "/?project=\(id)")
            } else {
                WebViewManager.shared.navigate(path: "/")
            }
        case "quota":
            // A quota opens ON the Quotas surface, and opens nothing — same
            // shape as `reminder` above. Tapping a quota from Track means
            // "show me that one", not "open its full detail page", which is
            // where `task/<id>` would send a tracked id instead.
            if let id = url.pathComponents.last.flatMap(Int.init) {
                WebViewManager.shared.navigate(path: "/quotas?quota=\(id)")
            } else {
                WebViewManager.shared.navigate(path: "/quotas")
            }
        case "quotas":
            WebViewManager.shared.navigate(path: "/quotas")
        case "overdue":
            // The Tasks widget's header on its Overdue page (2026-09-25) —
            // the dashboard with its Overdue chip on. See `WidgetLink.overdue`.
            WebViewManager.shared.navigate(path: "/?filter=overdue")
        default:
            WebViewManager.shared.navigate(path: "/")
        }
    }
}
