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
            if phase == .active {
                // Reloads triggered by the foregrounded app don't count against
                // the widget refresh budget, so the widgets are always current
                // by the time the user returns to the Home Screen.
                WidgetCenter.shared.reloadAllTimelines()

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
            let id = url.pathComponents.last.flatMap(Int.init)
            if let id {
                WebViewManager.shared.navigateToTask(id)
            } else {
                WebViewManager.shared.navigate(path: "/")
            }
        case "reminders":
            WebViewManager.shared.navigate(path: "/reminders")
        default:
            WebViewManager.shared.navigate(path: "/")
        }
    }
}
