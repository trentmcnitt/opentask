import SwiftUI
import WidgetKit

/// The watchOS Smart Stack widget extension entry point. One kind tonight
/// (`ReminderStackWidget`) — the task brief's Quotas widget equivalent was
/// out of scope (see `WatchRootView`'s doc), so there's nothing else to add
/// to the bundle yet.
@main
struct OpenTaskWatchWidgetBundle: WidgetBundle {
    var body: some Widget {
        ReminderStackWidget()
    }
}
