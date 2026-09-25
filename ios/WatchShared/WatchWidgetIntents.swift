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

/// ✓ (and ☐) on a quota PROMPT card (quota reminders, 2026-09-24). ✓ is
/// CONSIDERED — handled for today, no progress, the same verb ✓ is on a
/// reminder — and ☐ is DID IT (+1 and considered). Never `markDone`: the
/// server refuses a done on a quota. Keyed by `prompt_key`. Same optimistic
/// discipline as `ConsiderReminderIntent`: tombstone, repaint, server call,
/// write-through, clear on failure.
struct ActOnPromptCardIntent: AppIntent {
    static var title: LocalizedStringResource = "Quota Reminder"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Prompt Key")
    var promptKey: String

    @Parameter(title: "Did It", default: false)
    var did: Bool

    init() {}

    init(promptKey: String, did: Bool) {
        self.promptKey = promptKey
        self.did = did
    }

    func perform() async throws -> some IntentResult {
        let claim = "prompt-\(promptKey)"
        guard WatchWidgetState.tryClaim(claim) else { return .result() }
        defer { WatchWidgetState.releaseClaim(claim) }

        WatchWidgetState.stagePendingPrompt(key: promptKey, did: did)
        WidgetCenter.shared.reloadTimelines(ofKind: WatchWidgetState.kind)

        do {
            let result = did
                ? try await APIClient.shared.didPrompts(keys: [promptKey])
                : try await APIClient.shared.considerPrompts(keys: [promptKey])
            WatchCache.markPromptHandled(key: promptKey, did: did)
            // The quotas the server returned, into the cached task list the
            // watch app's Quotas page falls back to — server-true counts.
            if !result.tasks.isEmpty, let cached = WatchCache.loadTasks() {
                let byId = Dictionary(result.tasks.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
                WatchCache.saveTasks(cached.tasks.map { byId[$0.id] ?? $0 }, projects: cached.projects)
            }
        } catch {
            // Likeliest: a key from before midnight. The tombstone goes, and
            // the post-perform reload fetches today's prompts.
            WatchWidgetState.clearPendingPrompt(key: promptKey)
        }
        if #available(watchOS 11.0, *) {
            WidgetCenter.shared.invalidateRelevance(ofKind: WatchWidgetState.kind)
        }
        return .result()
    }
}

/// ⏭ — show the slot's next item (reminder or quota prompt) WITHOUT acting
/// on this one. Pure local state (`WatchWidgetState.skip`), no server call;
/// resets on its own when the slot or the day changes.
struct SkipReminderIntent: AppIntent {
    static var title: LocalizedStringResource = "Skip Reminder"
    static var isDiscoverable: Bool { false }

    /// The card item's key — `WatchWidgetState.itemKey(reminderId:)` for a
    /// reminder, the `prompt_key` for a quota prompt.
    @Parameter(title: "Item")
    var itemKey: String

    /// The on-screen slot's id (-1 for "Anytime") — the skip list is scoped
    /// to it.
    @Parameter(title: "Slot")
    var slotKey: Int

    /// Every still-waiting item key in that slot, in card order, so a skip
    /// that would leave nothing unskipped can wrap instead (see
    /// `WatchWidgetState.skip`). Passed in rather than re-read from cache so
    /// the decision is made against exactly what the user was looking at.
    @Parameter(title: "Remaining")
    var remainingKeys: [String]

    init() {}

    init(itemKey: String, slotKey: Int, remainingKeys: [String]) {
        self.itemKey = itemKey
        self.slotKey = slotKey
        self.remainingKeys = remainingKeys
    }

    func perform() async throws -> some IntentResult {
        WatchWidgetState.skip(itemKey: itemKey, slotKey: slotKey, remainingKeys: remainingKeys)
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
