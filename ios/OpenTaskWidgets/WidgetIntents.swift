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
///   Every mutating intent below reloads the ACTING kind alone before the
///   server call, then all three (acting kind first) after — see the
///   `reloadOpenTaskWidgets(activeKind:)` doc below for why the split isn't
///   symmetric (2026-09-22, the macOS lag fix).
/// - There are no swipe gestures in widgets, so paging between slots/projects
///   is done with explicit chevron intents rather than a gesture.
///
/// `isDiscoverable = false` throughout: these are widget plumbing, not things
/// a user should find in Shortcuts. Exposing "Move to next time slot" as a
/// user-facing shortcut would promise app state it does not have.

/// Reload all three widget kinds, acting kind first when given. Used for the
/// POST-network round only (2026-09-22, round 2 of the macOS lag fix) — by
/// then the server has genuinely changed state that any of the three kinds
/// could reflect, so all three are worth refreshing, and the acting kind's
/// corrected value goes first since it's the one the user is watching.
///
/// The PRE-network round does not call this — see each intent's `perform()`,
/// which reloads ONLY the acting kind via `reloadOpenTaskWidget(kind:)`
/// instead. Before the server has even been told about the change, the other
/// two kinds have nothing new to draw (a progress delta never changes what
/// Reminders/Tasks show; a completion's tombstone only affects the kind it's
/// staged against), so reloading them pre-network was pure queue noise ahead
/// of the one reload that could actually show something.
///
/// That noise mattered because, on macOS, `chronod` (WidgetKit's reload
/// daemon) runs every timeline reload for one extension bundle through ONE
/// SERIAL QUEUE — confirmed from `/usr/bin/log`: "Would pop task, but all
/// extensions are busy, namely [io.mcnitt.opentask.mac.widgets]" logged for
/// every kind but the one currently executing. Budget-free (also confirmed:
/// "overridden for budget exempt reason: free") does not mean concurrent.
///
/// Measured on two independent, isolated `+1` taps against the PRIOR code
/// (three kinds, unordered, both rounds): the PRE-network reload of the
/// tapped kind never got its own queue slot at all — chronod only logged a
/// `task submitted` for it AFTER `perform()` had already returned, after the
/// post-network reload had already superseded it. Whether narrowing round 1
/// to a single kind (this change) is enough to win that queue slot before
/// `perform()` returns, or whether chronod holds ANY reload from an
/// in-flight interaction regardless of how many kinds it names, is not yet
/// confirmed — needs a real, installed build and the same log-mining method
/// against real taps. Either way, round 2's reordering measurably helped: the
/// unordered post-network reload queued the acting kind behind Reminders'
/// and Tasks' passes — one of which (Reminders, ~692ms) is a real network
/// fetch, not a cache hit — pushing the user's own tap's first visible pixel
/// to 1.65s after they touched it. Acting-kind-first alone (no round-1
/// narrowing) was measured to roughly halve that.
@MainActor
func reloadOpenTaskWidgets(activeKind: String? = nil) {
    let kinds = [RemindersWidget.kind, TasksWidget.kind, TrackWidget.kind]
    let ordered: [String]
    if let activeKind, kinds.contains(activeKind) {
        ordered = [activeKind] + kinds.filter { $0 != activeKind }
    } else {
        ordered = kinds
    }
    for kind in ordered {
        WidgetCenter.shared.reloadTimelines(ofKind: kind)
    }
}

/// Reload ONE kind after a pure view-state change (a chevron page flip).
///
/// Data-mutating intents reload everything — a completion changes counts on
/// every kind. But a page flip is local to the widget being paged, and
/// reloading the other two kinds made every chevron tap pay for two unrelated
/// provider passes.
@MainActor
func reloadOpenTaskWidget(kind: String) {
    WidgetCenter.shared.reloadTimelines(ofKind: kind)
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

    /// Which widget kind the button that fired this lives in, so its reload
    /// can go first (see `reloadOpenTaskWidgets(activeKind:)`). Defaulted, not
    /// required, for the same archived-button reason as `IncrementProgressIntent.delta`
    /// — a widget snapshot pre-dating this parameter decodes it as "", which
    /// `reloadOpenTaskWidgets` treats as "no priority" rather than crashing.
    @Parameter(title: "Widget Kind", default: "")
    var kind: String

    init() {}

    init(taskId: Int, kind: String = "") {
        self.taskId = taskId
        self.kind = kind
    }

    func perform() async throws -> some IntentResult {
        // Optimistic (§8): tombstone the item and repaint from cache BEFORE the
        // server call — the round trip takes seconds and a delayed disappearance
        // reads as a dead button. The tombstone hides the item through the
        // reconciling fetch; a FAILED call clears it so the item honestly
        // reappears, never an alert the user can't act on from the Home Screen.
        WidgetStore.stagePendingCompletion(taskId)
        // ONLY the acting kind, round 1 (2026-09-22, round 2 of the macOS lag
        // fix — see `reloadOpenTaskWidgets(activeKind:)`). Reminders and Tasks
        // have nothing new to draw yet: the server doesn't know about this
        // completion until the call below returns, so their own reloads here
        // were pure queue noise ahead of the one reload that could actually
        // show something (the tombstone). Falls back to all three, unordered,
        // when `kind` is unknown (an archived pre-`kind`-parameter button) —
        // that case can't target just the acting kind, so it keeps the old,
        // safe-but-unoptimized behavior rather than guessing.
        if kind.isEmpty {
            await reloadOpenTaskWidgets()
        } else {
            await reloadOpenTaskWidget(kind: kind)
        }

        do {
            try await APIClient.shared.markDone(taskId: taskId)
        } catch {
            print("[OpenTaskWidgets] Complete \(taskId) failed: \(error)")
            WidgetStore.clearPendingCompletion(taskId)
        }
        // All three, round 2: the server now knows, so counts genuinely may
        // have changed on the other kinds too, and the user isn't waiting on
        // this repaint the way they were on round 1's.
        await reloadOpenTaskWidgets(activeKind: kind.isEmpty ? nil : kind)
        return .result()
    }
}

// MARK: - Track progress

/// Log a signed progress step on a tracked task (§5).
///
/// Hits `/api/tasks/:id/progress`, NOT a completion endpoint: a sub-target
/// increment dispatches `task.progressed` and leaves the task open until its
/// period boundary, so overflow like 3/2 stays visible.
///
/// One intent for both directions rather than a separate decrement intent — the
/// only difference is the sign, and two intents would mean two copies of the
/// pin/stage/reconcile sequence below.
struct IncrementProgressIntent: AppIntent {
    static var title: LocalizedStringResource = "Log Progress"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Task ID")
    var taskId: Int

    /// `+1` logs, `−1` corrects a mis-log.
    ///
    /// Defaulted at the PARAMETER, not merely in the convenience init: `+1`
    /// buttons already sitting on a Home Screen were archived by a build that
    /// had no `delta` at all, and a parameter with no default would decode
    /// those archives as 0 — every existing button silently becoming a no-op
    /// after the update.
    @Parameter(title: "Delta", default: 1)
    var delta: Int

    init() {}

    init(taskId: Int, delta: Int = 1) {
        self.taskId = taskId
        self.delta = delta
    }

    func perform() async throws -> some IntentResult {
        // Pin the Track selection to the item being logged. The default
        // selection is "most behind-pace", and logging progress changes pace —
        // without the pin, tapping +1 could swap the 2×2 to a DIFFERENT quota
        // before the user sees their own count tick up (observed live: +1 on
        // Beef 0/4 flipped the widget to Broccoli).
        WidgetStore.trackSelection = taskId

        // Same optimistic discipline as CompleteTaskIntent: stage, repaint,
        // then let the server catch up. The staged value is a NET count, so
        // three taps in a row draw +3 instead of the single +1 a stamp-only
        // map could express.
        WidgetStore.stagePendingProgress(taskId, delta: delta)
        // ONLY Track, round 1 (2026-09-22, round 2 of the macOS lag fix — see
        // `reloadOpenTaskWidgets(activeKind:)`). A progress delta never
        // changes what Reminders or Tasks show — Tasks explicitly excludes
        // tracked items (see the widgets table in ios/CLAUDE.md) — so their
        // round-1 reloads were never anything but queue noise ahead of the one
        // that draws the staged value. This is the reload that has to win a
        // chronod queue slot before `perform()` returns for the optimistic
        // repaint to exist at all.
        await reloadOpenTaskWidget(kind: TrackWidget.kind)

        do {
            try await APIClient.shared.logProgress(taskId: taskId, delta: delta)
        } catch {
            print("[OpenTaskWidgets] Progress \(taskId) \(delta > 0 ? "+" : "")\(delta) failed: \(error)")
        }
        // Unconditional, and deliberately a SUBTRACTION of this call's own
        // delta rather than a wipe: on success the server now carries it, on
        // failure the optimistic draw reverts, and either way a sibling tap
        // still in flight keeps its own staged delta (see
        // `WidgetStore.clearPendingProgress`).
        WidgetStore.clearPendingProgress(taskId, delta: delta)
        // All three, round 2, Track first. A progress delta alone never
        // changes what Reminders or Tasks show — Tasks excludes anything
        // `isTracked` regardless of progress (see `TasksTimeline`), and
        // Reminders is an unrelated feed — so neither draws anything new
        // here. Kept anyway for parity with `CompleteTaskIntent` and to stay
        // inside the scope of this fix. Worth knowing for a follow-up: Tasks'
        // pass has no stamp to fast-path on (only Track was staged), so it
        // re-fetches `/api/tasks` on its own — a second fetch of the same
        // endpoint `TaskFeed`'s doc says never to add. Dropping Reminders and
        // Tasks from THIS intent's round 2 entirely would be correct and
        // would remove that fetch, since nothing they show can change from a
        // progress delta in either round.
        await reloadOpenTaskWidgets(activeKind: TrackWidget.kind)
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
        // View-state only: fast path + single-kind reload, so the flip paints
        // from cache instead of waiting out a network fetch.
        WidgetStore.markInteraction()
        await reloadOpenTaskWidget(kind: RemindersWidget.kind)
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
        // View-state only: fast path + single-kind reload (see ShiftReminderSlotIntent).
        WidgetStore.markInteraction()
        await reloadOpenTaskWidget(kind: TasksWidget.kind)
        return .result()
    }
}

// MARK: - Track item paging

/// Move the Track widget's selection one quota earlier or later.
///
/// Paging wraps, like the other two rings. The selection is what the 2×2 and
/// the Lock Screen families render, and — once there are more quotas than rows
/// — where the systemMedium/Large list window starts, so one intent drives
/// every family's notion of "which quota".
///
/// The ordering it steps through is `TrackTimeline.orderedItems`' — the same
/// stored, membership-stable order the provider rendered, recomputed here from
/// the same cache, so a chevron always lands on the item the user can see is
/// next rather than on whatever pace happens to rank there now.
struct ShiftTrackItemIntent: AppIntent {
    static var title: LocalizedStringResource = "Change Tracked Item"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Offset")
    var offset: Int

    init() {}

    init(offset: Int) {
        self.offset = offset
    }

    func perform() async throws -> some IntentResult {
        let tasks = WidgetStore.loadTasks()?.value.tasks ?? []
        // Tombstoned completions filtered out, exactly as the provider does
        // (`TaskFeed.snapshot`): a tracked reminder checked off elsewhere is
        // still in this raw cache for 90s, and `orderedItems` PERSISTS the
        // order for whatever membership it is handed — so an unfiltered set
        // here would rewrite the stored order behind the provider's back and
        // shuffle the list on the next pass. Staged progress deltas need no
        // such care: they move counts, never membership.
        let items = TrackTimeline.orderedItems(from: WidgetStore.filterPending(tasks))
        guard items.count > 1 else { return .result() }

        let current = items.firstIndex { $0.id == TrackTimeline.selectedId(in: items) } ?? 0
        let count = items.count
        WidgetStore.trackSelection = items[((current + offset) % count + count) % count].id
        // View-state only: fast path + single-kind reload (see ShiftReminderSlotIntent).
        WidgetStore.markInteraction()
        await reloadOpenTaskWidget(kind: TrackWidget.kind)
        return .result()
    }
}
