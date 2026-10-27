import SwiftUI
import WidgetKit

/// The OpenTask widget extension.
///
/// Three *separate* widget kinds rather than one configurable widget, because
/// each kind gets its own refresh budget (§8) — a busy Tasks widget can't
/// starve the Reminders widget of reloads. The user can stack them if they
/// want the swipe between them; Smart Stack supplies the gesture that widgets
/// themselves are not allowed to have.
///
/// Gallery order is §8's order of importance: Reminders, Tasks, Track.
@main
struct OpenTaskWidgetBundle: WidgetBundle {
    /// Scoped Undo (2026-10-26, `UndoScope`): every mutation this extension
    /// sends — the outbox drain's included — records its `undo_id` as this
    /// surface's own. One surface for all three kinds (and on the Mac, its
    /// widgets alone).
    init() {
        installWidgetUndoRecorder()
    }

    var body: some Widget {
        RemindersWidget()
        TasksWidget()
        TrackWidget()
    }
}
