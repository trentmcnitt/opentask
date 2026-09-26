// Test-target-only stand-ins for the two widget kind strings WidgetStore
// reads (`clearInteraction(kind:)`, `confirmRestore(_:kind:)`).
//
// The real `RemindersWidget`/`TasksWidget` are SwiftUI/WidgetKit types in
// ios/OpenTaskWidgets/{RemindersWidget,TasksWidget}.swift, which this
// Foundation-only bundle does not compile. KEEP THE STRINGS IN STEP with
// their `static let kind` — WidgetStore only compares them, so a mismatch
// here would make a test exercise the wrong branch, never crash.

enum RemindersWidget {
    static let kind = "OpenTaskReminders"
}

enum TasksWidget {
    static let kind = "OpenTaskTasks"
}
