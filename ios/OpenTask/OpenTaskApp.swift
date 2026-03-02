import SwiftUI

@main
struct OpenTaskApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            if AppConfig.shared.isConfigured {
                ContentView()
            } else {
                SetupView()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // Process deferred quick action from cold launch. For snooze actions,
            // APIClient reads credentials from Keychain directly (no WebView needed).
            // For add-task, WebViewManager stores a pendingPath if the WebView isn't
            // created yet — WebView.makeUIView consumes it on initial load.
            if phase == .active, AppConfig.shared.isConfigured, let item = appDelegate.savedShortcutItem {
                appDelegate.savedShortcutItem = nil
                appDelegate.handleShortcutItem(item, completionHandler: { _ in })
            }
        }
    }
}
