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
///   Every mutating intent below reloads the ACTING kind alone, both rounds
///   (2026-09-22, the macOS lag fix) — see `reloadOpenTaskWidget(kind:)`'s
///   doc for the invariant that makes this correct, not just fast.
/// - There are no swipe gestures in widgets, so paging between slots/projects
///   is done with explicit chevron intents rather than a gesture.
///
/// `isDiscoverable = false` throughout: these are widget plumbing, not things
/// a user should find in Shortcuts. Exposing "Move to next time slot" as a
/// user-facing shortcut would promise app state it does not have.

/// Reload ONE kind. The primary reload path for every intent below —
/// mutating and view-state alike (2026-09-22, the macOS lag fix).
///
/// It used to be that mutating intents reloaded all three kinds, on the
/// theory that "a completion changes counts on one widget and can change the
/// list on another." That theory is false for every mutation this file
/// performs. The three kinds partition the open-task set with NO overlap:
///
/// - Reminders ⊆ tasks where `is_reminder = true`
/// - Track ⊆ tasks where `isTracked` (`trackedFlag || progressTarget > 1`)
/// - Tasks ⊆ tasks where NEITHER of the above (`TasksTimeline`,
///   `.filter { !$0.isReminder && !$0.isTracked }`)
///
/// and reminder/tracked are mutually exclusive BY CONSTRUCTION, not by
/// convention: `refuseTrackedReminder` in `src/core/validation/task.ts`
/// rejects any create/update where both are true, with the comment "an item
/// is tracked or it is a reminder, never both." A task's membership in this
/// partition is also invariant under everything a widget button can do to
/// it — completing or logging progress never flips `is_reminder` or
/// `progress_target`. So completing a Reminders item can only change
/// Reminders; completing a Tasks item can only change Tasks (and there is no
/// Track call site for `CompleteTaskIntent` at all — grep confirms its only
/// two `Button(intent:)` sites are `RemindersWidgetViews.swift` and
/// `TasksWidgetViews.swift` — so "acting kind ∈ {Reminders, Tasks}" is
/// structural, not assumed); logging progress can only change Track. Reloading
/// the other two kinds was never keeping anything honest — it was queue
/// noise, and on macOS that noise was the whole latency bug (see
/// `reloadOpenTaskWidgets()` below for the measurement).
@MainActor
func reloadOpenTaskWidget(kind: String) {
    WidgetCenter.shared.reloadTimelines(ofKind: kind)
}

/// Reload all three widget kinds, unordered. NOT used by any ROUTINE mutating
/// intent's normal path as of 2026-09-22 — see `reloadOpenTaskWidget(kind:)`.
/// Two callers remain, both deliberate exceptions to "reload only the acting
/// kind":
///
/// - `CompleteTaskIntent`'s fallback for a button archived before it carried
///   a `kind` parameter: without a known kind there is nothing to target, so
///   it falls back to the old, safe-but-unoptimized "reload everything"
///   rather than guessing.
/// - `UndoLastActionIntent` (2026-09-23), unconditionally: `/api/undo`'s
///   response carries no task id or kind (see its own doc), so which kind
///   the undone action belongs to is never knowable, and undo is rare enough
///   that the chronod queue-contention cost this function exists to avoid
///   for routine taps (see the measurements below) is not the relevant
///   tradeoff for an action a user fires a few times a day at most.
///
/// Otherwise this function has no other callers, which is itself evidence for
/// the fix: on macOS, `chronod` (WidgetKit's reload daemon) runs every timeline
/// reload for one extension bundle through ONE SERIAL QUEUE — confirmed from
/// `/usr/bin/log`: "Would pop task, but all extensions are busy, namely
/// [io.mcnitt.opentask.mac.widgets]" logged for every kind but the one
/// currently executing. Budget-free (also confirmed: "overridden for budget
/// exempt reason: free") does not mean concurrent, so every reload of a kind
/// nothing can visibly change was pure contention against the one that
/// mattered.
///
/// Measured, in order, against real taps from Trent:
/// 1. Prior code (three kinds, unordered, both rounds): the PRE-network
///    reload of the tapped kind never won a queue slot before `perform()`
///    returned — first visible pixel 1.65s after the tap.
/// 2. Acting-kind-first, still three kinds both rounds: split, ~0.62s when
///    the queue was otherwise clear, ~1.66s when another reload of this
///    extension — this tap's own round-2 Reminders/Tasks passes, or a
///    scheduled refresh — was still draining ahead of it.
/// 3. This change (single kind, both rounds — pending live confirmation):
///    round 2 of any tap is now exactly one reload. A second `+1` landing
///    within that one pass's runtime (~535ms observed) still queues behind
///    it — that's the honest floor, one pass deep rather than two or three.
@MainActor
func reloadOpenTaskWidgets() {
    WidgetCenter.shared.reloadTimelines(ofKind: RemindersWidget.kind)
    WidgetCenter.shared.reloadTimelines(ofKind: TasksWidget.kind)
    WidgetCenter.shared.reloadTimelines(ofKind: TrackWidget.kind)
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

    /// Which widget kind the button that fired this lives in — Reminders or
    /// Tasks, never Track (see `reloadOpenTaskWidget(kind:)`'s partition
    /// argument) — so only that kind gets reloaded. Defaulted, not required,
    /// for the same archived-button reason as `IncrementProgressIntent.delta`:
    /// a widget snapshot pre-dating this parameter decodes it as "", which
    /// `reloadAffectedKind()` below reads as "unknown, reload everything"
    /// rather than crashing or guessing wrong.
    @Parameter(title: "Widget Kind", default: "")
    var kind: String

    init() {}

    init(taskId: Int, kind: String = "") {
        self.taskId = taskId
        self.kind = kind
    }

    /// `kind`-aware reload, shared by both rounds: the acting kind alone when
    /// known, all three when not (an archived button — see `kind`'s doc).
    private func reloadAffectedKind() async {
        if kind.isEmpty {
            await reloadOpenTaskWidgets()
        } else {
            await reloadOpenTaskWidget(kind: kind)
        }
    }

    func perform() async throws -> some IntentResult {
        // One instant for this whole action — shared by the auto-advance
        // snapshot below and `recordMutation` on success, so the two are
        // tagged with bit-identical timestamps (see WidgetStore's "Auto-
        // advance's own undo" section for why that tagging matters).
        let mutationInstant = Date()

        // Optimistic (§8): tombstone the item and repaint from cache BEFORE the
        // server call — the round trip takes seconds and a delayed disappearance
        // reads as a dead button. The tombstone hides the item through the
        // reconciling fetch; a FAILED call clears it so the item honestly
        // reappears, never an alert the user can't act on from the Home Screen.
        WidgetStore.stagePendingCompletion(taskId)
        // Reminders only (§6/§7 — Tasks has no slot concept to advance
        // through): Trent, 2026-09-23, "once I finish morning it should take
        // me automatically back to early morning ... so I can keep checking
        // things off and automatically switch." Runs BEFORE the first reload
        // below, using the same cache `filterPending` will draw from, so the
        // very next repaint shows the slot switch and the hidden item
        // together rather than as two separately visible steps. Snapshotted
        // first (unconditionally, even when `autoAdvanceSlot` turns out not
        // to change anything — restoring an unchanged override is a no-op)
        // so a failed completion below, or a later Undo, can put the display
        // back — see WidgetStore's "Auto-advance's own undo" section.
        let isReminders = kind == RemindersWidget.kind
        if isReminders, let cached = WidgetStore.loadReminders()?.value.groups {
            WidgetStore.snapshotSlotOverrideBeforeAutoAdvance(at: mutationInstant)
            RemindersTimeline.autoAdvanceSlot(after: taskId, in: cached, now: mutationInstant)
        }
        await reloadAffectedKind()

        do {
            try await APIClient.shared.markDone(taskId: taskId)
            WidgetStore.confirmCompletion(taskId)
            // Auto-advance correlation only now (2026-09-23) — see
            // WidgetStore.recordMutation's doc.
            WidgetStore.recordMutation(now: mutationInstant)
            // Undo/Redo affordance (2026-09-23): reflect this new undoable
            // action immediately rather than waiting on the next scheduled
            // fetch — see WidgetStore.recordLocalMutationForUndoCount's doc.
            WidgetStore.recordLocalMutationForUndoCount()
        } catch {
            print("[OpenTaskWidgets] Complete \(taskId) failed: \(error)")
            WidgetStore.clearPendingCompletion(taskId)
            // The completion never happened — undo whatever `autoAdvanceSlot`
            // did above so the display doesn't stay parked on a slot chosen
            // for an action that failed.
            if isReminders {
                WidgetStore.restoreSlotOverrideBeforeAutoAdvance(ifMatches: mutationInstant)
            }
        }
        // Round 2 is the reconciling pass, and on failure it's the ONLY pass
        // that draws the truth: `clearPendingCompletion` just ran above, so
        // `hasRecentInteraction()` has no live stamp for this item, and the
        // provider takes the network path — the item honestly reappears
        // rather than staying hidden behind a tombstone the server rejected.
        // On success the tombstone is still live (90s TTL, untouched here),
        // so this pass fast-paths from cache and simply re-draws the same
        // hidden state round 1 already showed.
        await reloadAffectedKind()
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
        //
        // Deliberately NOT `WidgetStore.trackPageStart` too (2026-09-22, "Eggs
        // moves to the top"): that second value is what the systemMedium/Large
        // list window starts from, and only paging (`ShiftTrackItemIntent`)
        // should move it. Pinning the 2×2 here is a correctness fix (the
        // Broccoli bug above); rotating the list to match would just be the
        // same disorientation Trent flagged, now happening on every `+1`.
        WidgetStore.trackSelection = taskId

        // Takeback mode is NOT touched here (2026-09-24, Trent: auto-exit
        // after one `−1` was "weird") — it stays on until the button is
        // tapped again, or a Track timeline is built for a reason other than
        // this widget's own taps (`TrackProvider.currentEntry`). The
        // interaction stamp below is what keeps this tap's own round 2, and
        // the server's widget push that follows it ~2s later, reading as
        // "ours" rather than "a change elsewhere".
        //
        // It is also, with `confirmProgress` below, what makes both rounds
        // draw the same number: every pass inside the window repaints from a
        // cache that the confirmed result has already been written into.
        WidgetStore.markInteraction()

        // Same optimistic discipline as CompleteTaskIntent: stage, repaint,
        // then let the server catch up. The staged value is a NET count, so
        // three taps in a row draw +3 instead of the single +1 a stamp-only
        // map could express.
        WidgetStore.stagePendingProgress(taskId, delta: delta)
        // ONLY Track, both rounds (2026-09-22 — see `reloadOpenTaskWidget(kind:)`
        // for the partition argument: a progress delta cannot change what
        // Reminders or Tasks show, in either round, so this was never a
        // latency-vs-correctness tradeoff). Round 1 is the reload that has to
        // win a chronod queue slot before `perform()` returns for the
        // optimistic repaint to exist at all.
        await reloadOpenTaskWidget(kind: TrackWidget.kind)

        // Every outcome retires THIS call's staged delta and nothing else — a
        // sibling tap still in flight keeps its own (see
        // `WidgetStore.clearPendingProgress`).
        do {
            if let confirmed = try await APIClient.shared.logProgress(taskId: taskId, delta: delta) {
                // The server's count goes INTO the cache, in the same lock
                // hold that retires the delta — THE fix for "the widget never
                // shows the new count" (2026-09-24; see
                // `WidgetStore.confirmProgress`'s doc for the whole bug).
                // Subtracting alone used to leave the cache at the pre-tap
                // count, and any pass that fast-pathed from it — round 2
                // below whenever another tap was < 10s old, the server's
                // push right after — drew the old number back.
                WidgetStore.confirmProgress(confirmed, delta: delta)
            } else {
                // Logged, but the body didn't decode: nothing trustworthy to
                // write, so retire the delta and make the next pass fetch.
                WidgetStore.clearPendingProgress(taskId, delta: delta)
                WidgetStore.clearInteraction(kind: TrackWidget.kind)
            }
            // Undo/Redo affordance (2026-09-23) — see
            // WidgetStore.recordLocalMutationForUndoCount's doc. A `−1`
            // correction is just as undoable as a `+1`, so both record.
            WidgetStore.recordLocalMutationForUndoCount()
        } catch {
            print("[OpenTaskWidgets] Progress \(taskId) \(delta > 0 ? "+" : "")\(delta) failed: \(error)")
            // The cache still holds the pre-tap count, so retiring the delta
            // IS the honest revert — no fetch needed to show it.
            WidgetStore.clearPendingProgress(taskId, delta: delta)
        }
        // Round 2, still Track only: the reconciling pass. Inside the
        // interaction window it repaints from cache — which now holds the
        // server's count on success, or the untouched pre-tap count on
        // failure — so it draws the same number round 1 did (success) or the
        // honest revert (failure), never a stale one in between.
        await reloadOpenTaskWidget(kind: TrackWidget.kind)
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

/// Jump straight to a specific slot — `ReminderSlotStrip`'s segments
/// (2026-09-23, "I'd like to be able to tap a segment to jump to that
/// section"). Same storage as `ShiftReminderSlotIntent` (`WidgetStore.
/// setSlotOverride`), just addressed by the target slot's own key instead of
/// an offset from the currently displayed one — a segment tap names its
/// destination directly, it doesn't need to be counted as N steps away.
struct JumpToReminderSlotIntent: AppIntent {
    static var title: LocalizedStringResource = "Jump to Time Slot"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Slot Key")
    var slotKey: Int

    init() {}

    init(slotKey: Int) {
        self.slotKey = slotKey
    }

    func perform() async throws -> some IntentResult {
        let groups = WidgetStore.loadReminders()?.value.groups ?? []
        // A widget on the Home Screen can be tapped against an archived
        // snapshot from before the cache last refreshed — guard against a
        // slot key that no longer exists rather than setting an override
        // `displayedSlotIndex` can never resolve back to.
        guard groups.contains(where: { $0.slotKey == slotKey }) else { return .result() }

        let natural = RemindersTimeline.naturalSlotIndex(in: groups)
        WidgetStore.setSlotOverride(slotKey: slotKey, naturalSlotKey: groups[natural].slotKey)
        // View-state only: fast path + single-kind reload (see ShiftReminderSlotIntent).
        WidgetStore.markInteraction()
        await reloadOpenTaskWidget(kind: RemindersWidget.kind)
        return .result()
    }
}

// MARK: - Tasks project paging

/// Cycle the Tasks widget's scope: Today → Up next → each project the server
/// returned → Today (2026-09-23, item 4 — two unified pages up front, then
/// the per-project pages as before).
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

        // Scope ring: Today, then Up next, then one entry per project that
        // actually has something in today's set.
        let ring = [WidgetStore.allProjects, WidgetStore.upNextScope]
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

// MARK: - Reminders list paging (2026-09-23, the bottom pager)

/// Move the Reminders systemLarge list's bottom pager one page — the
/// `‹ 1/3 ›` control that replaced "+N more" (Trent: "It'd be nice to be
/// able to page through things that are too long to fit"). Unlike the slot/
/// project/quota rings, this does NOT wrap: `ListPager` dims and disables
/// the button at either end (`page == 0` / `page == totalPages - 1`, computed
/// by the view's height-based paging — see `RemindersListView.listBody`), so
/// `perform()` only ever has to clamp the
/// lower bound; the view's own live clamp handles the upper one, including
/// when the list shrinks out from under a stale page (a check-off).
struct ShiftReminderPageIntent: AppIntent {
    static var title: LocalizedStringResource = "Page Reminders List"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Offset")
    var offset: Int

    init() {}

    init(offset: Int) {
        self.offset = offset
    }

    func perform() async throws -> some IntentResult {
        let groups = WidgetStore.filterPending(WidgetStore.loadReminders()?.value.groups ?? [])
        let index = RemindersTimeline.displayedSlotIndex(in: groups)
        guard groups.indices.contains(index) else { return .result() }

        let slotKey = groups[index].slotKey
        let current = WidgetStore.remindersPage(for: slotKey)
        WidgetStore.setRemindersPage(current + offset, for: slotKey)
        // View-state only: fast path + single-kind reload (see ShiftReminderSlotIntent).
        WidgetStore.markInteraction()
        await reloadOpenTaskWidget(kind: RemindersWidget.kind)
        return .result()
    }
}

// MARK: - Tasks list paging

/// The Tasks twin of `ShiftReminderPageIntent` — same non-wrapping pager,
/// scoped to the project (or "Up next") currently on screen.
struct ShiftTasksPageIntent: AppIntent {
    static var title: LocalizedStringResource = "Page Tasks List"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Offset")
    var offset: Int

    init() {}

    init(offset: Int) {
        self.offset = offset
    }

    func perform() async throws -> some IntentResult {
        let scope = WidgetStore.projectScope
        let current = WidgetStore.tasksPage(for: scope)
        WidgetStore.setTasksPage(current + offset, for: scope)
        // View-state only: fast path + single-kind reload (see ShiftReminderSlotIntent).
        WidgetStore.markInteraction()
        await reloadOpenTaskWidget(kind: TasksWidget.kind)
        return .result()
    }
}

// MARK: - Track item paging

/// Move the Track widget's selection one quota earlier or later.
///
/// Paging wraps, like the other two rings. It writes BOTH `trackSelection`
/// (what the 2×2 and Lock Screen families render) and `trackPageStart` (where
/// the systemMedium/Large list window starts) to the same stepped-to id —
/// still one intent driving every family's notion of "which quota", even
/// though the two are now separate sticky values (2026-09-22, "Eggs moves to
/// the top" — see `WidgetStore.trackPageStart`'s doc). `IncrementProgressIntent`
/// is the only thing that moves `trackSelection` without also moving
/// `trackPageStart`; a chevron tap is explicitly a request to change what's
/// displayed, so both moving together here is correct, not the bug that fix
/// is about.
///
/// The step-from position is `selectedId` (the pin), not `pageStartId` —
/// deliberately unchanged from before the two split: the small family's own
/// chevrons have no window, only "the current quota", so they must keep
/// stepping from whatever the 2×2 is actually showing. Kept identical for the
/// list's chevron too rather than given a second stepping rule, since that
/// would be new, unmeasured behavior; a list chevron tapped shortly after a
/// `+1` elsewhere may jump further than one row as a result, but a chevron is
/// an explicit "move" request, so a jump in response to it isn't the
/// disorientation the pin/page-start split exists to prevent.
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
        let steppedId = items[((current + offset) % count + count) % count].id
        WidgetStore.trackSelection = steppedId
        WidgetStore.trackPageStart = steppedId
        // View-state only: fast path + single-kind reload (see ShiftReminderSlotIntent).
        WidgetStore.markInteraction()
        await reloadOpenTaskWidget(kind: TrackWidget.kind)
        return .result()
    }
}

// MARK: - Quotas paging / show-met (`feat/quotas-widget`)

/// Move the Quotas widget's flowed chip layout one page. Unlike
/// `ShiftReminderPageIntent`/`ShiftTasksPageIntent`, there is no scope key to
/// pair this with (§5 has one flat page sequence, not per-slot/per-project) —
/// see `WidgetStore.quotasPage`'s doc for why the view clamps the upper bound
/// instead of this intent tracking a scope to reset against. Non-wrapping,
/// like the other two list pagers — `perform()` only clamps the lower bound,
/// the header/footer `ListPager` dims and disables at either end.
struct ShiftQuotasPageIntent: AppIntent {
    static var title: LocalizedStringResource = "Page Quotas List"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Offset")
    var offset: Int

    init() {}

    init(offset: Int) {
        self.offset = offset
    }

    func perform() async throws -> some IntentResult {
        WidgetStore.quotasPage += offset
        // View-state only: fast path + single-kind reload (see ShiftReminderSlotIntent).
        WidgetStore.markInteraction()
        await reloadOpenTaskWidget(kind: TrackWidget.kind)
        return .result()
    }
}

/// The Quotas bottom row's "met" dot (the header eye until 2026-09-24) — off (default) puts a met quota away in
/// its cluster, on shows every quota regardless of state. Dedicated to
/// Quotas, not a generic per-kind toggle: Reminders/Tasks' own "show
/// completed" (`feat/widget-days-show-completed`, built in parallel) reads a
/// COMPLETION, a different shape of state from a quota's "at or past target,
/// still open" — sharing one intent across both would only save a few lines
/// and would couple two features that don't otherwise touch.
struct ToggleQuotasShowMetIntent: AppIntent {
    static var title: LocalizedStringResource = "Toggle Met Quotas"
    static var isDiscoverable: Bool { false }

    init() {}

    func perform() async throws -> some IntentResult {
        WidgetStore.quotasShowMet.toggle()
        // View-state only: fast path + single-kind reload (see ShiftReminderSlotIntent).
        // Deliberately does NOT touch `quotasPage` — clamping happens at
        // render time (see `WidgetStore.quotasPage`'s doc), the same "store
        // only ever needs to move it, view clamps" idiom every other pager
        // in this file follows.
        WidgetStore.markInteraction()
        await reloadOpenTaskWidget(kind: TrackWidget.kind)
        return .result()
    }
}

/// The Quotas bottom row's "Takeback" button (2026-09-24) — flips Takeback
/// mode (`WidgetStore.quotasTakebackMode`, where the whole mode is
/// documented). Turning it OFF this way does nothing else — no `−1`, no
/// page move; turning it on doesn't touch the page either (met chips
/// appearing can reflow the pages, and the view clamps, same as the "met"
/// dot). View-state only, so the same fast path as every toggle here:
/// `markInteraction()` is also what keeps `TrackProvider` from treating
/// this very reload as "a change elsewhere" and clearing the mode it just
/// set.
struct ToggleQuotasTakebackModeIntent: AppIntent {
    static var title: LocalizedStringResource = "Toggle Takeback Mode"
    static var isDiscoverable: Bool { false }

    init() {}

    func perform() async throws -> some IntentResult {
        WidgetStore.quotasTakebackMode.toggle()
        WidgetStore.markInteraction()
        await reloadOpenTaskWidget(kind: TrackWidget.kind)
        return .result()
    }
}

// MARK: - Undo / Redo (2026-09-23)

/// Undo the most recent action from ANY of the three widget kinds. Trent:
/// "I need some way to ... undo the accidental tap" and "the undo should not
/// disappear like that. Even if you're not on that segment, undoing it
/// should still be allowed with some indication about what was undone."
///
/// Shown as one of `UndoRedoButtons`' two always-present icon buttons —
/// dimmed/disabled by `WidgetStore.canUndo`, the server's own undoable
/// count, not by a local clock (the old 60s-window design this replaced).
///
/// Calls the SAME `/api/undo` the web app's toast Undo button does
/// (`useTaskActions.handleUndo`, `src/app/api/undo/route.ts`): it undoes the
/// single most recent action for the signed-in user, with no task id in the
/// request or response. That means this intent cannot target "the task THIS
/// header's row was for" — only "whatever changed last" — exactly like the
/// web toast, and exactly why `WidgetStore.clearAllPendingState()` below
/// clears every optimistic marker rather than one.
struct UndoLastActionIntent: AppIntent {
    static var title: LocalizedStringResource = "Undo"
    static var isDiscoverable: Bool { false }

    init() {}

    func perform() async throws -> some IntentResult {
        // Atomic claim (see WidgetStore.tryClaimUndoRedo's doc): a
        // concurrent tap — a real double-tap, a second perform() while this
        // one's network call is still in flight, or an overlapping Redo tap
        // — is dropped rather than firing a second server call.
        guard WidgetStore.tryClaimUndoRedo() else { return .result() }
        defer { WidgetStore.releaseUndoRedoClaim() }

        // Round 1: ALL THREE kinds, unlike a routine check-off/+1 — see
        // reloadOpenTaskWidgets()'s doc for why undo is the deliberate
        // exception. This is what makes both buttons' state and the "Undid:
        // …" indication update everywhere right away rather than only
        // wherever this tap happened to land, and it runs before the
        // network call for the same "don't make a dead-looking button"
        // reason CompleteTaskIntent stages first.
        await reloadOpenTaskWidgets()

        do {
            let result = try await APIClient.shared.undoLastAction()
            // No task id to target — see this type's doc — so every
            // optimistic/confirmed marker is cleared rather than one guessed
            // at. See WidgetStore.clearAllPendingState's doc.
            WidgetStore.clearAllPendingState()
            // Server truth for the buttons' own enabled state — exact, not
            // the optimistic guess `recordLocalMutationForUndoCount` makes
            // for a completion/`+1`.
            WidgetStore.setUndoRedoCounts(undoable: result.undoableCount, redoable: result.redoableCount)
            // The "indication about what was undone" — shown in every
            // header's subtitle for WidgetStore.lastActionWindow seconds,
            // "whichever slot/page is on screen" (see WidgetStore's
            // "Last-action indication" doc for why this is header-level
            // state, not per-row).
            WidgetStore.recordLastAction(description: "Undid: \(result.description)")
            // The cache no longer holds what was undone — a confirmed
            // completion is taken OUT of it (see WidgetStore). Refetch before
            // redrawing, and clear the interaction stamp so the providers take
            // the network path, or the undone item never comes back (Trent,
            // 2026-09-23: "I pressed undo and nothing actually undid it" —
            // the server had undone it).
            WidgetStore.clearInteraction()
            if let payload = try? await APIClient.shared.fetchReminders() {
                WidgetStore.saveReminders(payload.groups)
            }
            if let tasks = try? await APIClient.shared.fetchOpenTasks(),
               let projects = try? await APIClient.shared.fetchProjects() {
                // Completions too (2026-09-23, "show completed") — this is a
                // full refetch outside `TaskFeed`, so without an explicit
                // fetch here `saveTasks` (no default on `completions` since
                // this file's fix — see `WidgetStore.saveTasks`'s doc) would
                // force this call site to pass SOMETHING, and passing `[]`
                // would wipe the DONE list cache on every undo/redo.
                let completions = (try? await APIClient.shared.fetchTodaysCompletions()) ?? []
                WidgetStore.saveTasks(tasks, projects: projects, completions: completions)
            }
            // If the action just reversed was a Reminders completion that
            // triggered `autoAdvanceSlot`, put the display back where it was
            // before that side effect — the completed item reappears in its
            // ORIGINAL slot, and the display should follow it there rather
            // than staying parked on whatever slot the completion jumped to.
            // Consumed (not merely peeked) only here, on SUCCESS — see
            // WidgetStore.consumeLastMutation's doc for why a failed call
            // below leaves it alone for a retry. A no-op when there is no
            // recorded mutation, or it doesn't match any snapshot on file
            // (the last action wasn't a Reminders completion, or didn't
            // trigger an auto-advance) — see WidgetStore's "Auto-advance's
            // own undo" section for why the match is required rather than
            // restoring unconditionally.
            if let mutatedAt = WidgetStore.consumeLastMutation() {
                WidgetStore.restoreSlotOverrideBeforeAutoAdvance(ifMatches: mutatedAt)
            }
        } catch {
            print("[OpenTaskWidgets] Undo failed: \(error)")
            // Nothing to roll back here (2026-09-23): the buttons' enabled
            // state and the auto-advance correlation are both left exactly
            // as they were — there is no window to restore any more, so a
            // retry is simply a second tap on the same still-enabled button.
        }
        // Round 2, the reconciling pass. On success the caches were just
        // refetched above (which also settled `clearInteraction()`'s
        // fetch-required stamps — `WidgetStore.saveTasks`), so a fast path
        // here draws server truth; a payload whose refetch failed keeps its
        // stamp and this pass fetches it. On failure nothing changed
        // server-side, so whatever path this takes is already current.
        // (Before 2026-09-24 a chevron tapped under 10s earlier could
        // fast-path this pass from a cache the refetch had not replaced.)
        await reloadOpenTaskWidgets()
        return .result()
    }
}

/// Redo the most recently undone action — the twin of `UndoLastActionIntent`,
/// calling `POST /api/redo` (`src/app/api/redo/route.ts`). Trent: "For undo
/// and redo I think we want undo and redo, ideally with an icon."
///
/// Deliberately does NOT touch the auto-advance-slot-override snapshot
/// `UndoLastActionIntent` restores: that snapshot only ever records "the
/// slot override as it stood immediately BEFORE an auto-advance", which has
/// nothing to replay forward for a redo, and `consumeLastMutation()` is left
/// untouched here so a Reminders completion made AFTER this redo can still
/// correlate correctly with a later undo.
struct RedoLastActionIntent: AppIntent {
    static var title: LocalizedStringResource = "Redo"
    static var isDiscoverable: Bool { false }

    init() {}

    func perform() async throws -> some IntentResult {
        // Shared claim with Undo — see UndoLastActionIntent's doc.
        guard WidgetStore.tryClaimUndoRedo() else { return .result() }
        defer { WidgetStore.releaseUndoRedoClaim() }

        await reloadOpenTaskWidgets()

        do {
            let result = try await APIClient.shared.redoLastAction()
            WidgetStore.clearAllPendingState()
            WidgetStore.setUndoRedoCounts(undoable: result.undoableCount, redoable: result.redoableCount)
            WidgetStore.recordLastAction(description: "Redid: \(result.description)")
            WidgetStore.clearInteraction()
            if let payload = try? await APIClient.shared.fetchReminders() {
                WidgetStore.saveReminders(payload.groups)
            }
            if let tasks = try? await APIClient.shared.fetchOpenTasks(),
               let projects = try? await APIClient.shared.fetchProjects() {
                // Completions too — see UndoLastActionIntent's identical
                // block for why.
                let completions = (try? await APIClient.shared.fetchTodaysCompletions()) ?? []
                WidgetStore.saveTasks(tasks, projects: projects, completions: completions)
            }
        } catch {
            print("[OpenTaskWidgets] Redo failed: \(error)")
        }
        await reloadOpenTaskWidgets()
        return .result()
    }
}

// MARK: - Show completed (2026-09-23)

/// Flip the "show completed" dot (`CompletedDotToggle`, the header eye until 2026-09-24) — see `WidgetStore`'s "Show
/// completed" section for the storage and why it's keyed by an arbitrary
/// `kind` string rather than plumbed through the entry.
struct ToggleShowCompletedIntent: AppIntent {
    static var title: LocalizedStringResource = "Show Completed"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Widget Kind")
    var kind: String

    init() {}

    init(kind: String) {
        self.kind = kind
    }

    func perform() async throws -> some IntentResult {
        WidgetStore.setShowCompleted(!WidgetStore.showCompleted(for: kind), for: kind)
        // View-state only: fast path + single-kind reload (see
        // ShiftReminderSlotIntent). No explicit page reset needed —
        // the lists' `listBody` already recompute `totalPages` from
        // whatever combined open+done list is currently showing and clamp
        // the stored page into range on every render, exactly like they
        // already do when a check-off shrinks the open list out from under
        // a stale page.
        WidgetStore.markInteraction()
        await reloadOpenTaskWidget(kind: kind)
        return .result()
    }
}

/// Restore a completed item to open — tapping a DONE row's trailing
/// checkmark (2026-09-23, "show completed"). Calls `APIClient.markUndone`
/// (`POST /api/tasks/:id/undone`), the same endpoint the web Reminders
/// surface's "put back" gesture uses, confirmed to generalize correctly to a
/// one-off Task too (see `APIClient.markUndone`'s doc). `kind` picks which
/// cached DONE list to reconcile — mirrors `CompleteTaskIntent.kind`.
///
/// Failure mode worth calling out (from the handoff): a RECURRING task/
/// reminder's restore can fail with "Task changed since it was completed" if
/// it was snoozed/edited/completed-again since — `markUndone`'s one real
/// failure case, narrow (same-day, already-modified-since-completion). This
/// intent does not attempt a global-undo fallback for that case; it simply
/// reverts the optimistic restore like any other failure (the item
/// reappears in DONE, still tappable for a retry) rather than guessing at a
/// broader recovery. Safe — no wrong-item corruption — even though it isn't
/// literally "non-interactive" the way a silent auto-recovery would be.
struct UncompleteTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Restore Task"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Task ID")
    var taskId: Int

    @Parameter(title: "Widget Kind")
    var kind: String

    init() {}

    init(taskId: Int, kind: String) {
        self.taskId = taskId
        self.kind = kind
    }

    func perform() async throws -> some IntentResult {
        // Optimistic (§8): tombstone it out of the DONE list and repaint
        // from cache before the server call — same discipline as
        // CompleteTaskIntent's own tombstone. `markInteraction()` matters
        // here specifically: `pendingRestores` isn't one of the sources
        // `hasRecentInteraction()` consults (unlike `pendingCompletions`),
        // so without this stamp round 1's reload would pay a real network
        // fetch instead of painting the tombstone instantly.
        WidgetStore.stagePendingRestore(taskId)
        WidgetStore.markInteraction()
        await reloadOpenTaskWidget(kind: kind)

        do {
            try await APIClient.shared.markUndone(taskId: taskId)
            // No honest way to put this back into OPEN from what the DONE
            // list carries (see WidgetStore.confirmRestore's doc) — drop the
            // tombstone permanently and clear the interaction stamp so the
            // reload below takes the network path and fetches the real
            // restored TaskDTO into OPEN.
            WidgetStore.confirmRestore(taskId, kind: kind)
            WidgetStore.clearInteraction(kind: kind.isEmpty ? nil : kind)
            // Undo/Redo affordance (2026-09-23) — restoring a task is just
            // as undoable as completing one (`markUndone` calls `logAction`
            // server-side, confirmed against `src/core/tasks/mark-done.ts`)
            // — see WidgetStore.recordLocalMutationForUndoCount's doc.
            WidgetStore.recordLocalMutationForUndoCount()
        } catch {
            print("[OpenTaskWidgets] Restore \(taskId) failed: \(error)")
            // The restore never happened — un-hide it from DONE so it is
            // honestly still there and tappable for a retry, the same
            // failure-reversion pattern CompleteTaskIntent uses. Also clear
            // the interaction stamp `markInteraction()` set above (round 1's
            // fast-path staging) — without this, round 2 below would still
            // see a live stamp and fast-path from cache instead of
            // confirming server truth, the one case this file's
            // "reconciling pass" comments are elsewhere careful to rule out.
            WidgetStore.clearPendingRestore(taskId)
            WidgetStore.clearInteraction(kind: kind.isEmpty ? nil : kind)
        }
        // Round 2, the reconciling pass — same reasoning as
        // CompleteTaskIntent's round 2: on success `clearInteraction()` just
        // ran, so this takes the network path and lands the restored task
        // into OPEN; on failure the tombstone was cleared AND the
        // interaction stamp was too (see the catch block above), so this
        // also takes the network path and the item honestly reappears in
        // DONE (never stuck hidden behind a tombstone the server rejected).
        await reloadOpenTaskWidget(kind: kind)
        return .result()
    }
}

// MARK: - Tasks snooze mode / bulk select (2026-09-23, Phase 2)
//
// Tasks-only (§6: reminders are bucket-locked and never snoozed) — none of
// these take a `kind` parameter the way the show-completed intents do, since
// there is only ever one Tasks widget kind to act on.
//
// WHERE A SNOOZE GOES (Trent, 2026-09-24, replacing 2026-09-23's "+1h is
// one hour from now for everything" — that instruction was wrong: at 10:04
// AM "+1 hour" on a task due 5 PM moved it to 11 AM, and "Next" on one due
// 8:30 PM moved it to noon). A per-row or bulk-select snooze now counts
// from the task's OWN time while it is upcoming, from now once it is
// overdue or undated — computed per task by `TaskSnoozePlan`
// (`TaskFeed.swift`, pure and harness-tested), which also turns a
// selection into the fewest `POST /api/tasks/bulk/snooze` requests: +1h is
// at most two (overdue/undated → one `until`, snapped from now; upcoming →
// one `delta_minutes: 60`, which the server adds to each task's own
// `due_at`), next period is one per distinct target slot. The "All
// overdue" bar is untouched: everything it moves is overdue, so from-now
// is right for all of it, and the server resolves it.
//
// `include_task_ids` is always sent equal to the ids being acted on for a
// per-row or bulk-select snooze (never for the sweep) — mirroring the web's
// OWN convention exactly (`save-quick-panel-changes.ts`: "explicit user
// selections always pass `include_task_ids` ... the sweep remains the only
// caller that omits it"). A deliberate, single-row or explicitly-selected
// tap must not be silently dropped by the P3/P4 sweep-safety filter meant
// for "snooze everything overdue" blanket sweeps.
//
// None of the snooze intents below stage anything optimistically (unlike
// `CompleteTaskIntent`'s tombstone) — a due-date change can move a task to a
// different scope/page/sort position in ways this file has no reliable way
// to predict client-side, and neither does the web app: `useSnoozeOverdue`'s
// own sweep just calls `fetchTasks()` once after the response lands, no
// optimistic staging there either. So these call the API, then reload ONCE
// with `clearInteraction()` forcing the network path, rather than running
// CompleteTaskIntent's stage/repaint/reconcile two-round shape.

/// The header clock toggle — flips Tasks' snooze mode. Mutually exclusive
/// with select mode: turning snooze mode ON also turns select mode off and
/// clears any in-progress selection, since a row's trailing control can only
/// be one thing at a time (see `WidgetStore`'s "Tasks snooze mode / bulk
/// select" section doc).
struct ToggleTasksSnoozeModeIntent: AppIntent {
    static var title: LocalizedStringResource = "Toggle Snooze Mode"
    static var isDiscoverable: Bool { false }

    init() {}

    func perform() async throws -> some IntentResult {
        let next = !WidgetStore.tasksSnoozeMode
        WidgetStore.tasksSnoozeMode = next
        if next {
            WidgetStore.tasksSelectMode = false
            WidgetStore.clearTasksSelection()
        }
        // View-state only: fast path + single-kind reload (see ShiftReminderSlotIntent).
        WidgetStore.markInteraction()
        await reloadOpenTaskWidget(kind: TasksWidget.kind)
        return .result()
    }
}

/// The bottom-left "Select" control (resting mode only) — always ENTERS
/// select mode; exit is via `CancelTasksSelectModeIntent`'s "Cancel", never
/// this same button toggling back off. Select mode's own bottom-left slot is
/// simply empty (2026-09-23 review: Trent decided against a "select all" —
/// "'All overdue' in snooze mode covers everything-at-once, and Select is
/// for hand-picked sets" — see `SelectModeActionBar`'s doc).
struct EnterTasksSelectModeIntent: AppIntent {
    static var title: LocalizedStringResource = "Select Tasks"
    static var isDiscoverable: Bool { false }

    init() {}

    func perform() async throws -> some IntentResult {
        WidgetStore.tasksSelectMode = true
        WidgetStore.tasksSnoozeMode = false
        // Always a fresh start, never resuming a stale selection from a
        // previous select-mode session (there is no way to have gotten here
        // with a live selection anyway — Cancel/Done both clear it — but
        // this makes the invariant explicit rather than assumed).
        WidgetStore.clearTasksSelection()
        WidgetStore.markInteraction()
        await reloadOpenTaskWidget(kind: TasksWidget.kind)
        return .result()
    }
}

/// "Cancel" in select mode — exits without acting on anything.
struct CancelTasksSelectModeIntent: AppIntent {
    static var title: LocalizedStringResource = "Cancel Selection"
    static var isDiscoverable: Bool { false }

    init() {}

    func perform() async throws -> some IntentResult {
        WidgetStore.tasksSelectMode = false
        WidgetStore.clearTasksSelection()
        WidgetStore.markInteraction()
        await reloadOpenTaskWidget(kind: TasksWidget.kind)
        return .result()
    }
}

/// Tapping a row in select mode — the mockup's "tapping a row selects it
/// (the check-off circle becomes a selection circle)": the row's own `Link`
/// is replaced by this intent's `Button` entirely while select mode is on
/// (see `TaskRow`'s mode-gated body), so there is nowhere else for a select-
/// mode tap to go.
struct ToggleTaskSelectionIntent: AppIntent {
    static var title: LocalizedStringResource = "Toggle Task Selection"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Task ID")
    var taskId: Int

    init() {}

    init(taskId: Int) {
        self.taskId = taskId
    }

    func perform() async throws -> some IntentResult {
        let scope = WidgetStore.projectScope
        var ids = WidgetStore.selectedTaskIds(for: scope)
        if ids.contains(taskId) {
            ids.remove(taskId)
        } else {
            ids.insert(taskId)
        }
        WidgetStore.setSelectedTaskIds(ids, for: scope)
        WidgetStore.markInteraction()
        await reloadOpenTaskWidget(kind: TasksWidget.kind)
        return .result()
    }
}

/// Send a `TaskSnoozePlan`'s requests one after another, returning the ids
/// that actually moved (every id of each request that succeeded). Sequential
/// on purpose: each request is its own server undo entry, and firing them
/// concurrently would make the order they land on the undo stack — and so
/// which one the first Undo reverses — a race. A failed request doesn't
/// stop the rest: its ids simply aren't in the result, so the caller can
/// keep exactly those selected for a retry without re-moving the others.
private func sendSnoozeRequests(_ requests: [TaskSnoozePlan.Request]) async -> Set<Int> {
    var moved: Set<Int> = []
    for request in requests {
        do {
            switch request.kind {
            case .until(let until):
                try await APIClient.shared.bulkSnoozeTasks(
                    ids: request.ids, until: DateHelpers.formatISO(until), includeTaskIds: request.ids
                )
            case .deltaMinutes(let minutes):
                try await APIClient.shared.bulkSnoozeTasks(
                    ids: request.ids, deltaMinutes: minutes, includeTaskIds: request.ids
                )
            }
            moved.formUnion(request.ids)
            // Undo/Redo affordance — one server undo entry per request.
            WidgetStore.recordLocalMutationForUndoCount()
        } catch {
            print("[OpenTaskWidgets] Snooze \(request.ids) failed: \(error)")
        }
    }
    return moved
}

/// Snooze every currently-selected task at once — the select-mode bottom
/// bar's "⏭ Next period" / "+1h", each task to ITS OWN target
/// (`TaskSnoozePlan`, this section's header doc). `include_task_ids`
/// mirrors each request's ids (an explicit selection always bypasses the
/// P3/P4 sweep filter, matching the web). All moved: exit select mode and
/// clear the selection, matching "Done"'s own exit. Some or none moved:
/// stay in select mode with ONLY the ids that didn't move still picked, so a
/// retry can't move the others a second time (an upcoming task's +1h is a
/// delta — sent twice, it would land two hours later). `clearInteraction()`
/// runs either way, forcing the reload to confirm server truth.
struct SnoozeSelectedTasksIntent: AppIntent {
    static var title: LocalizedStringResource = "Snooze Selected Tasks"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Target")
    var target: String

    init() {}

    init(target: TaskSnoozeTarget) {
        self.target = target.rawValue
    }

    func perform() async throws -> some IntentResult {
        let scope = WidgetStore.projectScope
        let selected = WidgetStore.selectedTaskIds(for: scope)
        guard !selected.isEmpty else { return .result() }

        // No early `return` between here and the reload (the first cut's
        // bug, caught in review): a stale/disabled ⏭ firing with no cached
        // slots plans zero requests, and must still reconcile the widget.
        let requests = TaskSnoozePlan.requests(
            TaskSnoozeTarget(rawValue: target) ?? .plusOneHour,
            tasks: TaskFeed.cachedDueDates(for: selected.sorted()),
            now: Date(),
            slots: TimeSlotStore.cachedSlots
        )
        let moved = await sendSnoozeRequests(requests)
        let remaining = selected.subtracting(moved)
        if !moved.isEmpty, remaining.isEmpty {
            WidgetStore.tasksSelectMode = false
            WidgetStore.clearTasksSelection()
        } else {
            WidgetStore.setSelectedTaskIds(remaining, for: scope)
        }
        WidgetStore.clearInteraction(kind: TasksWidget.kind)
        await reloadOpenTaskWidget(kind: TasksWidget.kind)
        return .result()
    }
}

/// Complete every currently-selected task at once — the select-mode bottom
/// bar's "✓ Done". `POST /api/tasks/bulk/complete` (the SAME endpoint the
/// SLOT_REMINDER notification checklist already uses — see `ios/CLAUDE.md`'s
/// "Slot batch checklist"). Reuses `CompleteTaskIntent`'s exact optimistic
/// tombstone machinery per id (advisor review: "zero new mechanism") rather
/// than inventing a bulk-shaped tombstone — completion is the one action in
/// this section that DOES stage optimistically, because unlike a snooze a
/// completed task's fate (leave the open list) is completely predictable.
struct CompleteSelectedTasksIntent: AppIntent {
    static var title: LocalizedStringResource = "Complete Selected Tasks"
    static var isDiscoverable: Bool { false }

    init() {}

    func perform() async throws -> some IntentResult {
        let scope = WidgetStore.projectScope
        let ids = Array(WidgetStore.selectedTaskIds(for: scope))
        guard !ids.isEmpty else { return .result() }

        for id in ids { WidgetStore.stagePendingCompletion(id) }
        WidgetStore.markInteraction()
        await reloadOpenTaskWidget(kind: TasksWidget.kind)

        do {
            let affected = try await APIClient.shared.completeTasks(ids: ids)
            for id in ids { WidgetStore.confirmCompletion(id) }
            if affected > 0 { WidgetStore.recordLocalMutationForUndoCount() }
            WidgetStore.tasksSelectMode = false
            WidgetStore.clearTasksSelection()
        } catch {
            print("[OpenTaskWidgets] Complete selected failed: \(error)")
            // None of it happened — un-hide every id, the same failure-
            // reversion pattern CompleteTaskIntent uses for one.
            for id in ids { WidgetStore.clearPendingCompletion(id) }
        }
        // Round 2, the reconciling pass — same reasoning as
        // CompleteTaskIntent's: on success the tombstones are still live
        // (90s TTL), so this fast-paths from the now-edited cache; on
        // failure the tombstones were just cleared, so this takes the
        // network path and the tasks honestly reappear.
        await reloadOpenTaskWidget(kind: TasksWidget.kind)
        return .result()
    }
}

/// A single row's own "⏭"/"+1h" in snooze mode — the per-row twin of
/// `SnoozeSelectedTasksIntent`, one task instead of a selection, through
/// the same `TaskSnoozePlan` (so an upcoming row's +1h is its own due + 60,
/// a `delta_minutes: 60` request; an overdue one's is one hour from now,
/// snapped). `include_task_ids: [taskId]` for the same "an explicit,
/// deliberate tap bypasses the sweep filter" reasoning (this section's
/// header doc).
struct SnoozeTaskRowIntent: AppIntent {
    static var title: LocalizedStringResource = "Snooze Task"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Task ID")
    var taskId: Int
    @Parameter(title: "Target")
    var target: String

    init() {}

    init(taskId: Int, target: TaskSnoozeTarget) {
        self.taskId = taskId
        self.target = target.rawValue
    }

    func perform() async throws -> some IntentResult {
        // See `SnoozeSelectedTasksIntent`: zero planned requests (⏭ with no
        // cached slots) still falls through to `clearInteraction()` + reload.
        let requests = TaskSnoozePlan.requests(
            TaskSnoozeTarget(rawValue: target) ?? .plusOneHour,
            tasks: TaskFeed.cachedDueDates(for: [taskId]),
            now: Date(),
            slots: TimeSlotStore.cachedSlots
        )
        _ = await sendSnoozeRequests(requests)
        WidgetStore.clearInteraction(kind: TasksWidget.kind)
        await reloadOpenTaskWidget(kind: TasksWidget.kind)
        return .result()
    }
}

/// The "All overdue (N)" bar in snooze mode — the whole server-side overdue
/// sweep, via the SAME endpoint (`POST /api/tasks/bulk/snooze-overdue`) the
/// app's own header clock button and the bulk-snooze-to-slot notification
/// actions already use (`APIClient.snoozeOverdue`, no changes needed there).
/// Deliberately NO `include_task_ids` — this is the sweep, and the sweep is
/// exactly the caller meant to respect the P3(once-nothing-lower)/P4(never)
/// protection (this section's header doc's web-parity note).
struct SnoozeAllOverdueIntent: AppIntent {
    static var title: LocalizedStringResource = "Snooze All Overdue"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Target")
    var target: String

    init() {}

    init(target: TaskSnoozeTarget) {
        self.target = target.rawValue
    }

    func perform() async throws -> some IntentResult {
        do {
            switch TaskSnoozeTarget(rawValue: target) {
            case .nextPeriod, .none:
                try await APIClient.shared.snoozeOverdue(slot: "next")
            case .plusOneHour:
                try await APIClient.shared.snoozeOverdue(deltaMinutes: 60)
            }
            WidgetStore.recordLocalMutationForUndoCount()
        } catch {
            print("[OpenTaskWidgets] Snooze all overdue failed: \(error)")
        }
        WidgetStore.clearInteraction(kind: TasksWidget.kind)
        await reloadOpenTaskWidget(kind: TasksWidget.kind)
        return .result()
    }
}
