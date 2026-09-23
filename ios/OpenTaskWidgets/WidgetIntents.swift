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
            // §8-adjacent Undo affordance (2026-09-23) — see
            // WidgetStore.recordMutation's doc for the window this opens.
            WidgetStore.recordMutation(now: mutationInstant)
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

        do {
            try await APIClient.shared.logProgress(taskId: taskId, delta: delta)
            // §8-adjacent Undo affordance (2026-09-23) — see
            // WidgetStore.recordMutation's doc. A `−1` correction is just as
            // capable of being the accidental tap as a `+1`, so both stamp.
            WidgetStore.recordMutation()
        } catch {
            print("[OpenTaskWidgets] Progress \(taskId) \(delta > 0 ? "+" : "")\(delta) failed: \(error)")
        }
        // Unconditional, and deliberately a SUBTRACTION of this call's own
        // delta rather than a wipe: on success the server now carries it, on
        // failure the optimistic draw reverts, and either way a sibling tap
        // still in flight keeps its own staged delta (see
        // `WidgetStore.clearPendingProgress`).
        WidgetStore.clearPendingProgress(taskId, delta: delta)
        // Round 2, still Track only. This is the reconciling pass: the entry
        // `clearPendingProgress` just removed was the ONLY thing keeping
        // `hasRecentInteraction()` true for this task (this intent never
        // calls `markInteraction()`), so this pass takes the network path —
        // `/api/tasks` + `/api/projects` via `TaskFeed` — on both success and
        // failure, landing the server's real count or reverting an optimistic
        // one the call above rejected. Nothing to fast-path here even in
        // principle: server truth is exactly what a failed call needs shown.
        //
        // Not fixed here, flagged for a follow-up: this fetch is real and
        // unavoidable, but `logProgress` returns `Void` — if it returned the
        // updated task, writing it straight into `WidgetStore.saveTasks`
        // before this reload would turn round 2 into a cache hit instead.
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

// MARK: - Undo (2026-09-23, the accidental-tap fix)

/// Undo the most recent action from ANY of the three widget kinds. Trent:
/// "I need some way to ... undo the accidental tap." Shown as `UndoButton`
/// in a list header for `WidgetStore.undoWindow` seconds after a successful
/// check-off / `+1` / `−1` — see `WidgetStore.recordMutation`/`canUndo(at:)`.
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
        // Atomic claim (see WidgetStore.consumeUndo's doc): a concurrent tap
        // — a real double-tap, or a second perform() while this one's
        // network call is still in flight — gets nil and does nothing here,
        // so at most one server undo ever fires per mutation.
        guard let mutatedAt = WidgetStore.consumeUndo() else { return .result() }

        // Round 1: ALL THREE kinds, unlike a routine check-off/+1 — see
        // reloadOpenTaskWidgets()'s doc for why undo is the deliberate
        // exception. This is what makes the button disappear everywhere
        // right away rather than only wherever this tap happened to land,
        // and it runs before the network call for the same "don't make a
        // dead-looking button" reason CompleteTaskIntent stages first.
        await reloadOpenTaskWidgets()

        do {
            try await APIClient.shared.undoLastAction()
            // No task id to target — see this type's doc — so every
            // optimistic/confirmed marker is cleared rather than one guessed
            // at. See WidgetStore.clearAllPendingState's doc.
            WidgetStore.clearAllPendingState()
            // If the mutation just reversed was a Reminders completion that
            // triggered `autoAdvanceSlot`, put the display back where it was
            // before that side effect — the completed item reappears in its
            // ORIGINAL slot, and the display should follow it there rather
            // than staying parked on whatever slot the completion jumped to.
            // A no-op when `mutatedAt` doesn't match any snapshot on file
            // (the last action wasn't a Reminders completion, or didn't
            // trigger an auto-advance) — see WidgetStore's "Auto-advance's
            // own undo" section for why the match is required rather than
            // restoring unconditionally.
            WidgetStore.restoreSlotOverrideBeforeAutoAdvance(ifMatches: mutatedAt)
        } catch {
            print("[OpenTaskWidgets] Undo failed: \(error)")
            // Put the window back (at its ORIGINAL deadline, not a fresh 60s)
            // so a network blip is still retryable instead of silently
            // leaving the action un-undoable with no visible way back. The
            // auto-advance snapshot, if any, is deliberately left in place
            // too — the mutation didn't actually get reversed, so whatever
            // slot it advanced to is still the correct state until a retry
            // of THIS undo succeeds.
            WidgetStore.restoreMutation(at: mutatedAt)
        }
        // Round 2, the reconciling pass. `markInteraction()` is deliberately
        // never called here, so this takes the NETWORK path on both success
        // (server truth for whatever an undone task changed) and failure
        // (the window restored above re-shows "Undo"). One caveat, self-
        // healing: a chevron tapped under 10s before this would still leave
        // `hasRecentInteraction()` true, which fast-paths this ONE pass from
        // cache instead — the next scheduled or interaction-triggered reload
        // corrects it.
        await reloadOpenTaskWidgets()
        return .result()
    }
}
