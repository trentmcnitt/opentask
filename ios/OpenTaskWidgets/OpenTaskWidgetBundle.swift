import SwiftUI
import WidgetKit

/// The OpenTask widget extension.
///
/// Two *separate* widget kinds rather than one configurable widget, because
/// each kind gets its own refresh budget (§8) — a busy Tasks widget can't
/// starve the Reminders widget of reloads. The user can stack them if they
/// want the swipe between them; Smart Stack supplies the gesture that widgets
/// themselves are not allowed to have.
@main
struct OpenTaskWidgetBundle: WidgetBundle {
    var body: some Widget {
        RemindersWidget()
        TasksWidget()
    }
}
