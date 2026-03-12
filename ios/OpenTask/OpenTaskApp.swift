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
            if phase == .active {
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
}
