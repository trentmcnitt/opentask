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
                // Tell the page to refresh (and re-open its sync stream if it
                // has closed). The foreground usually fires visibilitychange
                // in the web view too; this is the belt-and-braces signal the
                // Mac app also sends, and `useSyncStream` dedupes the two.
                // No-op before the web view exists.
                WebViewManager.shared.webView?.evaluateJavaScript(
                    "window.dispatchEvent(new CustomEvent('opentask-app-active'))"
                )

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
            }
        }
    }

    /// Resolve an `opentask://` deep link from the widget extension to a web
    /// path and load it. The route table is `DeepLinkRouter` (ios/Shared),
    /// shared with the macOS app; a non-`opentask://` URL does nothing.
    private func handleWidgetLink(_ url: URL) {
        guard let path = DeepLinkRouter.webPath(for: url) else { return }
        WebViewManager.shared.navigate(path: path)
    }
}
