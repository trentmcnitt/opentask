import SwiftUI

@main
struct OpenTaskWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchAppDelegate.self) var delegate

    /// Scoped Undo (2026-10-26, `UndoScope`): the watch app and its Smart
    /// Stack card are one surface — every mutation either sends records its
    /// `undo_id` in `WatchCache.undoScope`.
    init() {
        WatchCache.installUndoRecorder()
    }

    var body: some Scene {
        WindowGroup {
            WatchRootView()
        }
    }
}
