import SwiftUI

@main
struct OpenTaskApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            if AppConfig.shared.isConfigured {
                ContentView()
            } else {
                SetupView()
            }
        }
    }
}
