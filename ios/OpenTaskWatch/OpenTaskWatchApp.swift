import SwiftUI

@main
struct OpenTaskWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchAppDelegate.self) var delegate

    var body: some Scene {
        WindowGroup {
            StatusView()
        }
    }
}
