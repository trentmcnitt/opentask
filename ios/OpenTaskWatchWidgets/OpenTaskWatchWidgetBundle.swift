import SwiftUI
import WidgetKit

/// The watchOS Smart Stack widget extension entry point. One kind
/// (`ReminderStackWidget`); quotas live in the watch app's Quotas page, not a
/// widget of their own.
@main
struct OpenTaskWatchWidgetBundle: WidgetBundle {
    /// Scoped Undo (2026-10-26, `UndoScope`): a Smart Stack tap is the
    /// watch's own action — the watch app's toolbar Undo takes it back
    /// (`WatchCache.undoScope`, shared through the App Group).
    init() {
        WatchCache.installUndoRecorder()
    }

    var body: some Widget {
        ReminderStackWidget()
    }
}
