import SwiftUI
import WidgetKit

/// The watchOS Smart Stack widget extension entry point. One kind
/// (`ReminderStackWidget`); quotas live in the watch app's Quotas page, not a
/// widget of their own.
@main
struct OpenTaskWatchWidgetBundle: WidgetBundle {
    var body: some Widget {
        ReminderStackWidget()
    }
}
