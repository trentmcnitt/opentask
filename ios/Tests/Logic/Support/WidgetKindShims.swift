// Test-target-only stand-ins for the widget kind strings WidgetStore and
// WidgetOutboxDrainer read (`clearInteraction(kind:)`, `confirmRestore(_:kind:)`,
// the drain report's kinds).
//
// The real `RemindersWidget`/`TasksWidget`/`TrackWidget` are SwiftUI/WidgetKit types in
// ios/OpenTaskWidgets/{RemindersWidget,TasksWidget,TrackWidget}.swift, which this
// Foundation-only bundle does not compile. KEEP THE STRINGS IN STEP with
// their `static let kind` — WidgetStore only compares them, so a mismatch
// here would make a test exercise the wrong branch, never crash.

enum RemindersWidget {
    static let kind = "OpenTaskReminders"
}

enum TasksWidget {
    static let kind = "OpenTaskTasks"
}

enum TrackWidget {
    static let kind = "OpenTaskTrack"
}
