import AppIntents
import WidgetKit

/// Every interaction the widgets support.
///
/// §8 platform facts these are built around:
///
/// - Interactive widgets are `AppIntent` buttons. On a locked device they are
///   inert until authentication, which is why the Lock Screen accessory
///   families below are glanceable-only and carry no buttons at all.
/// - Timeline reloads *triggered by a widget's own intent* are budget-free.
///   So every intent below ends by reloading BOTH kinds: a completion changes
///   the count on one widget and can change the list on the other, and paying
///   nothing for the second reload is strictly better than letting it drift.
/// - There are no swipe gestures in widgets, so paging between slots/projects
///   is done with explicit chevron intents rather than a gesture.
///
/// `isDiscoverable = false` throughout: these are widget plumbing, not things
/// a user should find in Shortcuts. Exposing "Move to next time slot" as a
/// user-facing shortcut would promise app state it does not have.

/// Reload both widget kinds. They read overlapping data (a reminder is a task
/// row server-side), so they are always refreshed as a pair.
@MainActor
func reloadOpenTaskWidgets() {
    WidgetCenter.shared.reloadTimelines(ofKind: RemindersWidget.kind)
    WidgetCenter.shared.reloadTimelines(ofKind: TasksWidget.kind)
}

// MARK: - Completion

/// Check off a single item (reminder or task).
///
/// Uses `/api/notifications/actions` with `action: "done"` — the same endpoint
/// the notification actions use — so recurrence advance, undo logging and
/// webhook dispatch all go through one server path.
struct CompleteTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Complete Task"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Task ID")
    var taskId: Int

    init() {}

    init(taskId: Int) {
        self.taskId = taskId
    }

    func perform() async throws -> some IntentResult {
        // A failed call is deliberately swallowed: the reload that follows
        // re-reads the server, so the row simply stays put rather than the
        // widget throwing an alert the user cannot act on from the Home Screen.
        do {
            try await APIClient.shared.markDone(taskId: taskId)
        } catch {
            print("[OpenTaskWidgets] Complete \(taskId) failed: \(error)")
        }
        await reloadOpenTaskWidgets()
        return .result()
    }
}

// MARK: - Track progress

/// Log +1 on a tracked task (§5).
///
/// Hits `/api/tasks/:id/progress`, NOT a completion endpoint: a sub-target
/// increment dispatches `task.progressed` and leaves the task open until its
/// period boundary, so overflow like 3/2 stays visible.
struct IncrementProgressIntent: AppIntent {
    static var title: LocalizedStringResource = "Log Progress"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Task ID")
    var taskId: Int

    init() {}

    init(taskId: Int) {
        self.taskId = taskId
    }

    func perform() async throws -> some IntentResult {
        do {
            try await APIClient.shared.incrementProgress(taskId: taskId)
        } catch {
            print("[OpenTaskWidgets] Progress \(taskId) failed: \(error)")
        }
        await reloadOpenTaskWidgets()
        return .result()
    }
}

// MARK: - Reminders slot paging

/// Move the Reminders widget one slot earlier or later.
///
/// Paging wraps. With a fixed handful of slots, wrapping is unambiguous and
/// avoids a dead chevron the user has no way to explain to themselves.
struct ShiftReminderSlotIntent: AppIntent {
    static var title: LocalizedStringResource = "Change Time Slot"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Offset")
    var offset: Int

    init() {}

    init(offset: Int) {
        self.offset = offset
    }

    func perform() async throws -> some IntentResult {
        let groups = WidgetStore.loadReminders()?.value.groups ?? []
        guard !groups.isEmpty else { return .result() }

        let natural = RemindersTimeline.naturalSlotIndex(in: groups)
        let current = RemindersTimeline.displayedSlotIndex(in: groups)
        let count = groups.count
        let target = ((current + offset) % count + count) % count

        WidgetStore.setSlotOverride(
            slotKey: groups[target].slotKey,
            naturalSlotKey: groups[natural].slotKey
        )
        await reloadOpenTaskWidgets()
        return .result()
    }
}

// MARK: - Tasks project paging

/// Cycle the Tasks widget's scope: All → each project the server returned → All.
///
/// The project list comes entirely from the cached payload. Nothing here knows
/// any project's name or how many there are (§7.1 leaves the project set open).
struct ShiftProjectScopeIntent: AppIntent {
    static var title: LocalizedStringResource = "Change Project"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Offset")
    var offset: Int

    init() {}

    init(offset: Int) {
        self.offset = offset
    }

    func perform() async throws -> some IntentResult {
        guard let cache = WidgetStore.loadTasks()?.value else { return .result() }

        // Scope ring: index 0 is "All", then one entry per project that
        // actually has something in today's set.
        let ring = [WidgetStore.allProjects]
            + TasksTimeline.scopedProjects(tasks: cache.tasks, projects: cache.projects).map(\.id)
        guard ring.count > 1 else { return .result() }

        let current = ring.firstIndex(of: WidgetStore.projectScope) ?? 0
        let count = ring.count
        WidgetStore.projectScope = ring[((current + offset) % count + count) % count]
        await reloadOpenTaskWidgets()
        return .result()
    }
}
