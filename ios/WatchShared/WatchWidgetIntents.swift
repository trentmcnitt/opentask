import AppIntents
import Foundation
import WidgetKit

// The Smart Stack card's interactive buttons (`Button(intent:)`). Interactive
// widgets are supported in EVERY watchOS widget family from watchOS 11 on
// (WWDC24 "What's new in watchOS 11": "All watchOS widget families support
// interactivity") — note Apple's "Adding interactivity to widgets" page lists
// accessoryCircular/Rectangular "on iPhone and iPad" only, which is the iOS
// Lock Screen rule (inert while locked), not a watchOS restriction. Below
// watchOS 11 (this target's deployment floor is 10) the buttons still draw
// but do nothing; the whole-card `widgetURL` keeps the card useful there.
//
// Compiled into BOTH watch targets (see `WatchWidgetState`'s doc). They run
// in the widget extension's process — none sets `openAppWhenRun` — so there
// are no haptics here (`WKInterfaceDevice` is the app's, not the
// extension's). When `perform()` returns, WidgetKit guarantees a timeline
// reload (free, not budgeted), which is how the card advances: every intent
// finishes its server call and its App Group writes BEFORE returning.

/// ✓ — consider (check off) the reminder on the card. Same server call the
/// watch app's tap-to-consider makes (`APIClient.markDone` → `POST
/// /api/notifications/actions` `done`), so the two surfaces can't disagree
/// about what "considered" means.
struct ConsiderReminderIntent: AppIntent {
    static var title: LocalizedStringResource = "Check Off Reminder"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Reminder ID")
    var taskId: Int

    init() {}

    init(taskId: Int) {
        self.taskId = taskId
    }

    func perform() async throws -> some IntentResult {
        let claim = "consider-\(taskId)"
        guard WatchWidgetState.tryClaim(claim) else { return .result() }
        defer { WatchWidgetState.releaseClaim(claim) }

        // Optimistic: tombstone first and repaint from cache, so the card
        // advances immediately instead of after the round trip. A failed
        // call clears the tombstone below and the reminder honestly comes
        // back on the post-perform reload.
        WatchWidgetState.stagePendingDone(taskId: taskId)
        WidgetCenter.shared.reloadTimelines(ofKind: WatchWidgetState.kind)

        do {
            try await APIClient.shared.markDone(taskId: taskId)
            // Patch the shared cache too, so a reload whose own fetch fails
            // (watch off Wi-Fi, phone out of range) still shows the advance
            // after the tombstone's TTL runs out.
            WatchCache.markReminderConsidered(taskId: taskId)
        } catch {
            WatchWidgetState.clearPendingDone(taskId: taskId)
        }
        if #available(watchOS 11.0, *) {
            WidgetCenter.shared.invalidateRelevance(ofKind: WatchWidgetState.kind)
        }
        return .result()
    }
}

/// ⏭ — show the slot's next reminder WITHOUT checking this one off. Pure
/// local state (`WatchWidgetState.skip`), no server call; resets on its own
/// when the slot or the day changes.
struct SkipReminderIntent: AppIntent {
    static var title: LocalizedStringResource = "Skip Reminder"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Reminder ID")
    var taskId: Int

    /// The on-screen slot's id (-1 for "Anytime") — the skip list is scoped
    /// to it.
    @Parameter(title: "Slot")
    var slotKey: Int

    /// Every still-pending reminder id in that slot, in card order, so a
    /// skip that would leave nothing unskipped can wrap instead (see
    /// `WatchWidgetState.skip`). Passed in rather than re-read from cache so
    /// the decision is made against exactly what the user was looking at.
    @Parameter(title: "Remaining")
    var remainingIds: [Int]

    init() {}

    init(taskId: Int, slotKey: Int, remainingIds: [Int]) {
        self.taskId = taskId
        self.slotKey = slotKey
        self.remainingIds = remainingIds
    }

    func perform() async throws -> some IntentResult {
        WatchWidgetState.skip(taskId: taskId, slotKey: slotKey, remainingIds: remainingIds)
        return .result()
    }
}

/// "Snooze all → next period": the overdue sweep, exactly the call the watch
/// app's bulk sheet makes (`APIClient.snoozeOverdue(slot: "next")` → `POST
/// /api/tasks/bulk/snooze-overdue` with `slot: "next"`, resolved server-side;
/// P3 only once nothing lower is left, P4 never — docs/TASK-MODEL.md). The
/// server's real counts are recorded for the card's result view.
struct SnoozeOverdueNextPeriodIntent: AppIntent {
    static var title: LocalizedStringResource = "Snooze Overdue to Next Period"
    static var isDiscoverable: Bool { false }

    /// The card's name for the target period ("Midday") at tap time, echoed
    /// back in the result so it can say where things went. Display only —
    /// the server resolves the actual time.
    @Parameter(title: "Target", default: "")
    var targetLabel: String

    init() {}

    init(targetLabel: String) {
        self.targetLabel = targetLabel
    }

    func perform() async throws -> some IntentResult {
        let claim = "snooze-overdue"
        guard WatchWidgetState.tryClaim(claim) else { return .result() }
        defer { WatchWidgetState.releaseClaim(claim) }

        do {
            let result = try await APIClient.shared.snoozeOverdue(slot: "next")
            WatchWidgetState.recordSnoozeResult(.init(
                at: Date(),
                tasksAffected: result.tasksAffected,
                snoozedHigh: result.snoozedHigh,
                skippedHigh: result.skippedHigh,
                skippedUrgent: result.skippedUrgent,
                targetLabel: targetLabel.isEmpty ? nil : targetLabel
            ))
            // Take what the sweep moved out of the cached task list, so a
            // reload whose own fetch fails can't fall back to the pre-snooze
            // overdue set and flip the card straight back into overdue mode.
            // Urgent always stays (never swept); High stays only when the
            // server says it skipped some.
            WatchCache.removeSweptOverdueTasks(keepHigh: result.skippedHigh > 0)
        } catch {
            // No result recorded: the card simply stays in overdue mode with
            // the button live for a retry.
        }
        if #available(watchOS 11.0, *) {
            WidgetCenter.shared.invalidateRelevance(ofKind: WatchWidgetState.kind)
        }
        return .result()
    }
}
