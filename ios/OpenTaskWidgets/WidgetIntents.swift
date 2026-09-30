import AppIntents
import WidgetKit

/// Every interaction the widgets support.
///
/// §8 platform facts these are built around:
///
/// - Interactive widgets are `AppIntent` buttons. On a locked device they are
///   inert until authentication, which is why the Lock Screen accessory
///   families below are glanceable-only and carry no buttons at all.
/// - On iOS, only ONE reload per tap is budget-free: WidgetKit's own reload
///   of the tapped widget's kind after `perform()` returns (chronod logs it
///   as `interaction-immediate-free`). Every `reloadTimelines(ofKind:)` this
///   extension issues is an `externalRequest … budgeted` reload, charged to
///   that kind's daily budget — see `reloadTappedWidget(kind:)` for the bug
///   that taught this (2026-09-25). So intents never ask for their own kind
///   on iOS, and ask for another kind only when the tap changed what that
///   kind shows (the partition in `reloadOpenTaskWidget(kind:)`'s doc).
///   macOS has no interaction reload and its extension reloads are free, so
///   there the tapped kind is still reloaded explicitly, both rounds
///   (2026-09-22, the macOS lag fix).
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
///
/// ONE AMENDMENT (quota reminders, 2026-09-24): the partition above is of
/// TASKS, and the Reminders payload now also carries quota PROMPTS — rows
/// computed from quota state. So a quota's count is shown by Reminders AND
/// Track: a prompt action (`ActOnPromptIntent`) and a Quotas `+1`/`−1`
/// (`IncrementProgressIntent`) each reload both of those kinds, never Tasks,
/// which still shows no quota at all.
@MainActor
func reloadOpenTaskWidget(kind: String) {
    WidgetCenter.shared.reloadTimelines(ofKind: kind)
}

/// Reload the kind whose button fired the intent — on macOS only.
///
/// "Quotas still 0/2 after did-it" (2026-09-25): the did-it square on the
/// Reminders widget's "Piano Scales · 0/2" prompt landed (prod: `POST
/// /api/quota-prompts/did` 200, Piano Scales 1/2, widget push sent 2s later),
/// the intent wrote the returned quota into the shared cache, and still the
/// phone's Quotas widget drew 0/2 until the app was opened. The same taps on
/// the iOS 27 simulator redraw Quotas every time (idb HID taps; no fetch, the
/// cache already held the new count), so the data path was sound: the Quotas
/// timeline simply wasn't rebuilt on the phone. chronod's log says why. The
/// only free reload of a tap is `interaction-immediate-free`, and it goes to
/// the TAPPED kind, after `perform()` returns. Every `reloadTimelines(ofKind:)`
/// from this extension — including ones for the tapped kind — is logged as
/// `externalRequest(… WidgetCenterServer …)-immediate-budgeted`, and the
/// server's widget push is budgeted too. Every intent here used to ask for
/// its own kind twice (before and after the server call), so every chevron,
/// toggle and `+1` spent budget on reloads WidgetKit was about to do for free
/// (the pre-call one is not even run: chronod logs "Delaying reload … because
/// entry is paused" until `perform()` returns, then replaces it). Once a
/// kind's budget is spent, its budgeted reloads are not run — and the only
/// way Quotas learns about a Reminders did-it is exactly such a reload (this
/// intent's cross-kind request, or the push). Trent's phone, read with
/// `idevicesyslog -p chronod` the same morning: Track's DAS budget -0.357
/// (Reminders 22.3), a queued Track reload left unrun, the widget-push
/// budget at -17. The simulator doesn't enforce
/// budgets, which is why it could never reproduce this, nor PR #82's "Quotas
/// stuck at 1/2 after Undo" (the same shape: the tapped Reminders repainted,
/// the cross-kind Quotas never did).
///
/// So on iOS this is a no-op, left at each call site to mark where the
/// tapped kind's repaint comes from. macOS is different: its chronod logs no
/// interaction reload at all (the Mac's reloads on 2026-09-23/24 were
/// `externalRequest … free`, `push … free`, `initial`), so there the explicit
/// reload IS the repaint, and both rounds stay.
///
/// The same fact is why check-offs no longer wait for the server inside
/// `perform()` (2026-09-30, instant check-off): the free reload can't run
/// until `perform()` returns, so every millisecond `perform()` spends on the
/// network is a millisecond the tap looks dead — and WidgetKit runs one
/// extension's intents serially, so the next tap waits too. They queue the
/// mutation in the outbox and return (`WidgetOutboxDrainer`); on macOS the
/// drain's report supplies round 2 (`applyOutboxReloads`).
@MainActor
func reloadTappedWidget(kind: String) {
    #if os(macOS)
    WidgetCenter.shared.reloadTimelines(ofKind: kind)
    #endif
}

/// Reload all three widget kinds, unordered. NOT used by any ROUTINE mutating
/// intent's normal path as of 2026-09-22 — see `reloadOpenTaskWidget(kind:)`.
/// One caller remains, a deliberate exception to "reload only the acting
/// kind": `CompleteTaskIntent`'s fallback for a button archived before it
/// carried a `kind` parameter — without a known kind there is nothing to
/// target, so it falls back to the old, safe-but-unoptimized "reload
/// everything" rather than guessing. (Undo/Redo also reload all three kinds,
/// since `/api/undo` names no task or kind, but through
/// `reloadAfterUndoRedo`, which orders them — see its doc.)
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

// MARK: - Outbox (2026-09-30, instant check-off)

/// The extension's one outbox drainer — see `WidgetOutboxDrainer`'s doc
/// (WidgetOutbox.swift) for the design, the idempotency rules and the retry
/// story. Every check-off-style intent enqueues and returns; this sends.
let widgetOutbox = WidgetOutboxDrainer(transport: APIClient.shared) { report in
    await applyOutboxReloads(report)
}

/// Turn a drain pass's report into reloads, spending as little budget as
/// the change allows (`reloadTappedWidget(kind:)`'s doc):
/// - A FAILED tap's kind must repaint the honest revert. On iOS that is a
///   budgeted reload — the tap's free interaction reload ran long before the
///   failure was known — and it is the one reload this design adds, on the
///   failure path only.
/// - A DEPENDENT kind (a prompt's quota on Quotas; a `+1`'s prompts on
///   Reminders) is asked for once per pass, however many taps the pass sent
///   — before the outbox it was one request per tap.
/// - A CONFIRMED tap's own kind already shows the confirmed state (its
///   optimistic marker drew it), so only macOS, which has no interaction
///   reload, repaints it: that is its old round 2.
@MainActor
func applyOutboxReloads(_ report: OutboxDrainReport) {
    var kinds = report.failedKinds.union(report.dependentKinds)
    #if os(macOS)
    kinds.formUnion(report.confirmedKinds)
    #endif
    // An archived button with no kind: nothing to target, reload everything
    // (see `reloadOpenTaskWidgets()`'s one remaining caller).
    if kinds.contains("") {
        reloadOpenTaskWidgets()
        return
    }
    for kind in kinds.sorted() {
        reloadOpenTaskWidget(kind: kind)
    }
}

/// Start sending the outbox WITHOUT waiting for it — the last thing a
/// mutating `perform()` does, and the first thing every provider does after
/// handing WidgetKit its timeline.
///
/// `performExpiringActivity` is Apple's way for an app extension to ask for
/// time to finish work (there is no `beginBackgroundTask` in an extension):
/// the block runs on a background queue and holds the assertion until the
/// drain finishes. If the system still suspends or ends the process, or the
/// activity expires first, nothing is lost — the entries are persisted, and
/// one cut off mid-send is verified or retired on the next drain.
///
/// macOS has no `performExpiringActivity`; there an activity assertion keeps
/// the extension from being napped mid-send, and the same persistence
/// covers the rest.
func kickWidgetOutbox() {
    guard !WidgetStore.outboxEntries().isEmpty else { return }
    #if os(macOS)
    Task.detached {
        let activity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated], reason: "Sending widget check-offs"
        )
        await widgetOutbox.drain()
        ProcessInfo.processInfo.endActivity(activity)
    }
    #else
    ProcessInfo.processInfo.performExpiringActivity(withReason: "Sending widget check-offs") { expired in
        guard !expired else { return }
        let finished = DispatchSemaphore(value: 0)
        Task.detached {
            await widgetOutbox.drain()
            finished.signal()
        }
        finished.wait()
    }
    #endif
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

    /// `kind`-aware reload before `perform()` returns: the acting kind alone
    /// when known (macOS only — `reloadTappedWidget`), all three when not (an
    /// archived button — see `kind`'s doc).
    private func reloadAffectedKind() async {
        if kind.isEmpty {
            await reloadOpenTaskWidgets()
        } else {
            await reloadTappedWidget(kind: kind)
        }
    }

    func perform() async throws -> some IntentResult {
        // One instant for this whole action — the auto-advance snapshot and
        // the outbox entry are tagged with it, so a failure or a later Undo
        // can restore the snapshot by exact match (WidgetStore's "Auto-
        // advance's own undo" section).
        let mutationInstant = Date()

        // A second tap on a row already checked off (a double tap landing
        // before the repaint, or a button archived before it): the first is
        // in flight or done, and completing a recurring task again would
        // advance it a SECOND occurrence. Nothing to do.
        guard !WidgetStore.pendingCompletions(now: mutationInstant).contains(taskId) else {
            return .result()
        }

        // The occurrence being checked off (`due_at`) goes into the outbox
        // entry: it is how a retried send knows the server hasn't already
        // done it (`WidgetOutboxDrainer`'s idempotency rules).
        let info = WidgetStore.cachedTaskInfo(taskId)

        // Optimistic (§8): tombstone the item — it is drawn gone from the
        // cache on the very next repaint. The tombstone (and the queued
        // entry, `WidgetStore.pendingCompletions`) hides it until the server
        // confirms; a FAILED send clears it so the item honestly reappears,
        // never an alert the user can't act on from the Home Screen.
        WidgetStore.stagePendingCompletion(taskId, now: mutationInstant)
        // Reminders only (§6/§7 — Tasks has no slot concept to advance
        // through): the owner, 2026-09-23, "once I finish morning it should
        // take me automatically back to early morning ... so I can keep
        // checking things off and automatically switch." Uses the same cache
        // `filterPending` will draw from, so the next repaint shows the slot
        // switch and the hidden item together. Snapshotted first
        // (unconditionally — restoring an unchanged override is a no-op) so
        // a failed completion, or a later Undo, can put the display back.
        let isReminders = kind == RemindersWidget.kind
        if isReminders, let cached = WidgetStore.loadReminders()?.value.groups {
            WidgetStore.snapshotSlotOverrideBeforeAutoAdvance(at: mutationInstant)
            RemindersTimeline.autoAdvanceSlot(in: cached, now: mutationInstant)
        }

        // THE CHANGE (2026-09-30, instant check-off): the server call no
        // longer happens here. On iOS the tap's only free repaint is
        // WidgetKit's reload of this kind AFTER `perform()` returns, and
        // intents run one at a time — awaiting `markDone` here made every
        // tap's first visible change a round trip, and a fourth rapid tap
        // wait for the first three's. The completion is queued, and sent
        // right after this returns (`kickWidgetOutbox`).
        WidgetStore.enqueueOutbox(WidgetStore.OutboxEntry(
            mutation: .complete(taskId: taskId, dueAt: info.dueAt),
            widgetKind: kind, createdAt: mutationInstant, title: info.title
        ))
        // Undo/Redo affordance: lit on this very repaint rather than after
        // the send. Exact once the send lands (every mutation logs one undo
        // entry and clears redo); the next fetch corrects it if it doesn't.
        WidgetStore.recordLocalMutationForUndoCount()

        // macOS has no interaction reload: this IS its repaint (round 1);
        // round 2 is the drain's (`applyOutboxReloads`). A no-op on iOS.
        await reloadAffectedKind()
        kickWidgetOutbox()
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
        let now = Date()
        WidgetStore.stagePendingProgress(taskId, delta: delta, now: now)

        // Queued, not awaited (2026-09-30, instant check-off — see
        // `CompleteTaskIntent.perform`). The drain writes the server's count
        // into the cache in the same lock hold that retires this delta
        // (`WidgetStore.confirmProgress`, the 2026-09-24 stale-count fix), so
        // every later pass draws the same number the staged one did. A `+1`
        // is sent AT MOST ONCE — the count can't be verified the way a
        // completion can — so an attempt that may or may not have landed
        // retires the delta and fetches (`WidgetOutboxDrainer`). The
        // Reminders widget's copy of this quota's count ("Piano Scales ·
        // 1/2") is refreshed by the drain too, once per pass, after the
        // server has answered (`OutboxDrainReport.dependentKinds`).
        WidgetStore.enqueueOutbox(WidgetStore.OutboxEntry(
            mutation: .progress(taskId: taskId, delta: delta),
            widgetKind: TrackWidget.kind, createdAt: now, title: nil
        ))
        // Undo/Redo affordance — a `−1` correction is just as undoable as a
        // `+1`. See WidgetStore.recordLocalMutationForUndoCount's doc.
        WidgetStore.recordLocalMutationForUndoCount()

        // ONLY Track (2026-09-22 — see `reloadOpenTaskWidget(kind:)` for the
        // partition argument). On macOS this is the repaint; on iOS it is a
        // no-op and WidgetKit's free interaction reload of Track after
        // `perform()` draws the staged count (`reloadTappedWidget(kind:)`).
        await reloadTappedWidget(kind: TrackWidget.kind)
        kickWidgetOutbox()
        return .result()
    }
}

// MARK: - Quota prompts (quota reminders, 2026-09-24)

/// Act on one quota PROMPT row of the Reminders widget: the round circle
/// (`did: false` — CONSIDERED for today, no progress) or the square
/// (`did: true` — DID IT: progress, and considered too). One intent for both
/// verbs, like `IncrementProgressIntent`'s signed delta: the only difference
/// is the endpoint, and two copies of the stage/confirm/reload sequence
/// below would drift.
///
/// Addressed by `promptKey`, never by task id — a daily quota's prompts in
/// different slots share one task id (`QuotaPromptDTO`'s doc).
///
/// THE SEQUENCE (`ios/AGENTS.md` § Optimistic; queued since 2026-09-30,
/// instant check-off — see `CompleteTaskIntent.perform`):
/// 1. Stage a tombstone by key, auto-advance, queue the action in the
///    outbox, and return — WidgetKit's free interaction reload repaints
///    Reminders from cache at once (`WidgetStore.filterPending` draws the
///    prompt handled).
/// 2. The outbox drain calls the server (`WidgetOutboxDrainer`). Success:
///    the server's answer goes into BOTH caches — the returned quotas into
///    Tasks/Quotas (`confirmTasks`), and into Reminders the prompt marked
///    handled plus every prompt of the same quota re-counted from the
///    returned count (`confirmPromptAction`: a did-it on Daily Walks #1 can
///    finish #2 in another slot — which now shows on the next repaint, not
///    this tap's own). A body that didn't decode marks both payloads
///    fetch-required instead. Then ONE Track reload per drain pass (see
///    `reloadOpenTaskWidget`'s amendment), after the count is in the cache.
/// 3. Definite failure (4xx — likeliest a key from before midnight, which
///    the server refuses): the tombstone and the auto-advance are put back,
///    Reminders is marked stale and repainted. Anything else is resent
///    (consider/did-it are idempotent per key).
struct ActOnPromptIntent: AppIntent {
    static var title: LocalizedStringResource = "Quota Reminder"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Prompt Key")
    var promptKey: String

    /// `true` = "did it" (the square); `false` = considered (the circle).
    @Parameter(title: "Did It", default: false)
    var did: Bool

    init() {}

    init(promptKey: String, did: Bool) {
        self.promptKey = promptKey
        self.did = did
    }

    func perform() async throws -> some IntentResult {
        // One instant for the auto-advance snapshot and the outbox entry, as
        // in `CompleteTaskIntent` (WidgetStore's "Auto-advance's own undo").
        let mutationInstant = Date()
        // Already handled or queued: a double tap before the repaint.
        guard WidgetStore.pendingPromptActions(now: mutationInstant)[promptKey] == nil else {
            return .result()
        }
        let cachedGroups = WidgetStore.loadReminders()?.value.groups
        let title = cachedGroups?.flatMap(\.prompts).first { $0.promptKey == promptKey }?.title
        WidgetStore.stagePendingPromptAction(promptKey, did: did, now: mutationInstant)
        // Auto-advance, exactly as a reminder check-off does: acting on the
        // slot's last waiting item moves the widget to the earliest started
        // slot that still has something. `autoAdvanceSlot` filters through
        // the tombstone just staged, so it sees this prompt as handled.
        // Snapshotted first so a failure, or a later Undo, puts it back.
        if let cachedGroups {
            WidgetStore.snapshotSlotOverrideBeforeAutoAdvance(at: mutationInstant)
            RemindersTimeline.autoAdvanceSlot(in: cachedGroups, now: mutationInstant)
        }
        WidgetStore.enqueueOutbox(WidgetStore.OutboxEntry(
            mutation: .prompt(key: promptKey, did: did),
            widgetKind: RemindersWidget.kind, createdAt: mutationInstant, title: title
        ))
        WidgetStore.recordLocalMutationForUndoCount()
        // macOS's repaint; iOS repaints on the free interaction reload.
        await reloadTappedWidget(kind: RemindersWidget.kind)
        kickWidgetOutbox()
        return .result()
    }
}

// MARK: - Put back a quota prompt (2026-09-25)

/// The filled dashed circle on a handled prompt in the Reminders widget's
/// DONE section: PUT IT BACK — it waits for today again, and a did-it's
/// progress comes off (`POST /api/quota-prompts/restore`; never `/undone`,
/// which a quota refuses). Before this the marker was an inert glyph and a
/// tap on the row fell through to its `Link` and opened the app (Trent,
/// 2026-09-25).
///
/// `ActOnPromptIntent`'s shape, minus the auto-advance (a put-back adds a
/// waiting row; there is nothing to advance away from):
/// 1. Stage a put-back tombstone by `prompt_key`, so the row leaves DONE and
///    is drawn waiting at once (macOS repaints here; iOS on the free
///    interaction reload after `perform()`).
/// 2. On success the server's answer goes into BOTH caches — the returned
///    quotas into Tasks/Quotas (`confirmTasks`: the Quotas widget's count may
///    have dropped), and the prompt un-handled plus every sibling re-counted
///    into Reminders (`confirmPromptRestore`, which retires the tombstone and
///    marks Reminders fetch-required where only the server knows the answer).
/// 3. On failure the tombstone goes and Reminders fetches — the likeliest
///    failure is a key from before midnight (400).
/// 4. Round 2 asks for Track, the OTHER kind (budget rules, `ios/AGENTS.md`);
///    Reminders is the tapped kind — free on iOS, explicit on macOS.
struct RestorePromptIntent: AppIntent {
    static var title: LocalizedStringResource = "Put Back Quota Reminder"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Prompt Key")
    var promptKey: String

    init() {}

    init(promptKey: String) {
        self.promptKey = promptKey
    }

    func perform() async throws -> some IntentResult {
        // Put back before the action it reverses was ever sent (the outbox,
        // 2026-09-30): take the queued action back locally — nothing to tell
        // the server, and nothing for Undo to find later.
        if let cancelled = WidgetStore.cancelQueuedOutboxEntry(where: {
            if case .prompt(let key, _) = $0 { return key == promptKey }
            return false
        }) {
            WidgetStore.revertOptimisticState(of: cancelled)
            WidgetStore.forgetLocalMutationForUndoCount()
            WidgetStore.markInteraction()
            await reloadTappedWidget(kind: RemindersWidget.kind)
            return .result()
        }
        // One mid-send (or queued behind a failure) has to reach the server
        // first, or the restore would find nothing to put back.
        await widgetOutbox.drain()

        WidgetStore.stagePendingPromptRestore(promptKey)
        await reloadTappedWidget(kind: RemindersWidget.kind)

        do {
            let result = try await APIClient.shared.restorePrompts(keys: [promptKey])
            WidgetStore.confirmTasks(result.tasks)
            WidgetStore.confirmPromptRestore(promptKey, tasks: result.tasks)
            if !result.decoded {
                WidgetStore.requireRemindersFetch()
                WidgetStore.requireTasksFetch()
            }
            WidgetStore.recordLocalMutationForUndoCount()
        } catch {
            print("[OpenTaskWidgets] Prompt \(promptKey) put back failed: \(error)")
            WidgetStore.clearPendingPromptRestore(promptKey)
            WidgetStore.requireRemindersFetch()
        }
        await reloadOpenTaskWidget(kind: TrackWidget.kind)
        await reloadTappedWidget(kind: RemindersWidget.kind)
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
        await reloadTappedWidget(kind: RemindersWidget.kind)
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
        await reloadTappedWidget(kind: RemindersWidget.kind)
        return .result()
    }
}

// MARK: - Tasks project paging

/// Cycle the Tasks widget's scope: Overdue (while anything is, 2026-09-25) →
/// Today → Up next → each project with something due today → back to the
/// start (2026-09-23, item 4 — the unified pages up front, then the
/// per-project pages as before). The ring is `TasksTimeline.scopeRing`.
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
        // The ring and the page on screen come from the same resolution the
        // provider draws with (`TasksTimeline.scopeState` — Overdue first
        // while anything is overdue, then Today, Up next, each project with
        // something due today), so "one step from here" is one step from what
        // the user is looking at, not from a stale stored choice.
        guard let state = TasksTimeline.currentScopeState(), state.ring.count > 1 else { return .result() }

        let ring = state.ring
        let current = ring.firstIndex(of: state.scope) ?? 0
        let count = ring.count
        // Stored WITH the natural default it was chosen against, so it lapses
        // when that changes — see `WidgetStore.TasksScopeChoice`.
        WidgetStore.setTasksScopeChoice(
            ring[((current + offset) % count + count) % count], naturalScope: state.natural
        )
        // View-state only: fast path + single-kind reload (see ShiftReminderSlotIntent).
        WidgetStore.markInteraction()
        await reloadTappedWidget(kind: TasksWidget.kind)
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
        await reloadTappedWidget(kind: RemindersWidget.kind)
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
        let scope = TasksTimeline.currentScope()
        let current = WidgetStore.tasksPage(for: scope)
        WidgetStore.setTasksPage(current + offset, for: scope)
        // View-state only: fast path + single-kind reload (see ShiftReminderSlotIntent).
        WidgetStore.markInteraction()
        await reloadTappedWidget(kind: TasksWidget.kind)
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
        await reloadTappedWidget(kind: TrackWidget.kind)
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
        await reloadTappedWidget(kind: TrackWidget.kind)
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
        await reloadTappedWidget(kind: TrackWidget.kind)
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
        await reloadTappedWidget(kind: TrackWidget.kind)
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
///
/// ONE reload per kind, AFTER the refetch (2026-09-25, "Quotas stuck at 1/2
/// after Undo") — see `reloadAfterUndoRedo`'s doc for the bug and why.
struct UndoLastActionIntent: AppIntent {
    static var title: LocalizedStringResource = "Undo"
    static var isDiscoverable: Bool { false }

    /// The widget kind whose header held the tapped button — the one kind
    /// WidgetKit reloads by itself when `perform()` returns, so
    /// `reloadAfterUndoRedo` asks for the OTHER kinds first. Defaulted like
    /// `CompleteTaskIntent.kind`: a button archived before this parameter
    /// existed decodes "" and gets the plain all-three order.
    @Parameter(title: "Widget Kind", default: "")
    var kind: String

    init() {}

    init(kind: String) {
        self.kind = kind
    }

    func perform() async throws -> some IntentResult {
        // Atomic claim (see WidgetStore.tryClaimUndoRedo's doc): a
        // concurrent tap — a real double-tap, a second perform() while this
        // one's network call is still in flight, or an overlapping Redo tap
        // — is dropped rather than firing a second server call.
        guard WidgetStore.tryClaimUndoRedo() else { return .result() }
        defer { WidgetStore.releaseUndoRedoClaim() }

        // The outbox first (2026-09-30, instant check-off): `/api/undo`
        // reverses the server's LAST action, so a tap still queued would make
        // it reverse the one before — the wrong tap. Send what's queued, then
        // undo. If something is still queued after that (offline), the
        // newest tap that never left the device is the "last action", and
        // taking it back is local: no server call at all.
        await widgetOutbox.drain()
        if let cancelled = WidgetStore.cancelNewestQueuedOutboxEntry() {
            WidgetStore.revertOptimisticState(of: cancelled)
            WidgetStore.forgetLocalMutationForUndoCount()
            WidgetStore.recordLastAction(description: "Undid: \(cancelled.title ?? "last tap")")
            WidgetStore.markInteraction()
            await reloadAfterLocalCancel(of: cancelled, tappedKind: kind)
            return .result()
        }

        // No reload before the server call (2026-09-25): nothing a widget
        // draws has changed yet — the undo hasn't happened and "Undid: …"
        // isn't recorded — so a pass here could only repaint the old state,
        // and it cost the one reload per kind that mattered (see
        // `reloadAfterUndoRedo`).
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
            await refetchAllPayloads()
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
        // The one reconciling pass. On success the caches were just
        // refetched above (which also settled `clearInteraction()`'s
        // fetch-required stamps — `WidgetStore.saveTasks`), so a fast path
        // here draws server truth; a payload whose refetch failed keeps its
        // stamp and this pass fetches it. On failure nothing changed
        // server-side, so whatever path this takes is already current.
        await reloadAfterUndoRedo(tappedKind: kind)
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

    /// See `UndoLastActionIntent.kind`.
    @Parameter(title: "Widget Kind", default: "")
    var kind: String

    init() {}

    init(kind: String) {
        self.kind = kind
    }

    func perform() async throws -> some IntentResult {
        // Shared claim with Undo — see UndoLastActionIntent's doc.
        guard WidgetStore.tryClaimUndoRedo() else { return .result() }
        defer { WidgetStore.releaseUndoRedoClaim() }

        // Queued taps first — a new action clears the redo stack server-side,
        // and redoing ahead of one the user already made would replay the
        // wrong thing (see UndoLastActionIntent).
        await widgetOutbox.drain()

        // No reload before the server call — see UndoLastActionIntent.
        do {
            let result = try await APIClient.shared.redoLastAction()
            WidgetStore.clearAllPendingState()
            WidgetStore.setUndoRedoCounts(undoable: result.undoableCount, redoable: result.redoableCount)
            WidgetStore.recordLastAction(description: "Redid: \(result.description)")
            WidgetStore.clearInteraction()
            await refetchAllPayloads()
        } catch {
            print("[OpenTaskWidgets] Redo failed: \(error)")
        }
        await reloadAfterUndoRedo(tappedKind: kind)
        return .result()
    }
}

/// Undo/Redo's full refetch of both cached payloads (they can't know what
/// they reversed, so both may be stale), the reminders and the tasks sides
/// CONCURRENTLY — they are independent, and every second `perform()` spends
/// before its reload is a second the widgets show the pre-undo state.
///
/// Completions too (2026-09-23, "show completed") — this is a full refetch
/// outside `TaskFeed`, so without an explicit fetch here `saveTasks` (no
/// default on `completions` — see `WidgetStore.saveTasks`'s doc) would force
/// this call site to pass SOMETHING, and passing `[]` would wipe the DONE
/// list cache on every undo/redo.
///
/// Each side saves only if its fetch succeeded; one that failed keeps the
/// fetch-required stamp `clearInteraction()` just set, so the reload that
/// follows fetches it instead of repainting the stale cache.
private func refetchAllPayloads() async {
    async let reminders: Void = refetchReminders()
    async let tasks: Void = refetchTasks()
    _ = await (reminders, tasks)
}

private func refetchReminders() async {
    if let payload = try? await APIClient.shared.fetchReminders() {
        WidgetStore.saveReminders(payload.groups)
    }
}

private func refetchTasks() async {
    async let open = APIClient.shared.fetchOpenTasks()
    async let projects = APIClient.shared.fetchProjects()
    async let completions: [CompletionDTO]? = try? APIClient.shared.fetchTodaysCompletions()
    guard let open = try? await open, let projects = try? await projects else {
        _ = await completions
        return
    }
    WidgetStore.saveTasks(open, projects: projects, completions: await completions ?? [])
}

/// Undo/Redo's reload: every kind ONCE, after the refetch, the kinds OTHER
/// than the tapped one first (2026-09-25, "Quotas stuck at 1/2 after Undo").
///
/// The bug: did-it on the Reminders widget's "Piano Scales · 0/2" prompt
/// (Quotas → 1/2), then Undo on the Reminders widget. The server undid it,
/// Reminders put the prompt back, and Quotas stayed at 1/2. Prod's request
/// log for Trent's tap (09:07:11) shows the whole story: the refetch below
/// ran (`/api/reminders`, `/api/tasks`, `/api/projects`, `/api/completions`
/// — so the shared tasks cache held 0/2 from 09:07:13), then exactly ONE
/// provider build fetched — Reminders' (`/api/reminders` + `/api/undo/status`)
/// — and no Tasks or Quotas build ran at all until the app was opened a
/// minute later (a Quotas build always fetches `/api/tasks`,
/// `/api/user/preferences` and `/api/time-slots` once it's > 10s after a
/// tap, which it was). The code path itself is right — the same sequence
/// driven against dev in a harness, and on the simulator by real widget
/// taps, rebuilds Quotas at 0/2 every time; on the phone, WidgetKit simply
/// never ran the Quotas reload this intent asked for.
///
/// What this intent did differently from the did-it tap whose cross-kind
/// Quotas reload DID land a few seconds earlier: it had already reloaded all
/// three kinds once, BEFORE the server call — a pass that could only repaint
/// the old state — and then asked again ~1.3s later. The only reload WidgetKit
/// is guaranteed to run is its own reload of the widget that holds the
/// tapped button, after `perform()` returns; a second request for another
/// kind in the same `perform()` is not. So: no reload before the server call
/// (there is nothing new to draw), then one request per kind with the kinds
/// the system will NOT reload by itself first — on the phone the first build
/// in line (Reminders, at XXX Large) was the only one that happened.
///
/// Why it happened (found 2026-09-25 — see `reloadTappedWidget(kind:)`):
/// the tapped kind's repaint was WidgetKit's free interaction reload, and
/// every request this extension makes is a BUDGETED reload, the other kinds'
/// included; with Track's budget spent, the Quotas request was not run. So
/// the tapped kind is no longer requested here on iOS (it is reloaded for
/// free, and a request would only spend its budget), and the other kinds are
/// requested once each.
/// Undo that took back a tap still in the outbox (never sent): only the
/// kind that tap changed has anything new to draw, and the tapped kind shows
/// "Undid: …". The tapped kind is free on iOS; the tap's own kind, when it
/// is a different one, is the one budgeted request.
@MainActor
private func reloadAfterLocalCancel(of entry: WidgetStore.OutboxEntry, tappedKind: String) async {
    if entry.widgetKind.isEmpty {
        reloadOpenTaskWidgets()
        return
    }
    if entry.widgetKind != tappedKind {
        reloadOpenTaskWidget(kind: entry.widgetKind)
    }
    reloadTappedWidget(kind: tappedKind)
}

@MainActor
private func reloadAfterUndoRedo(tappedKind: String) async {
    let all = [RemindersWidget.kind, TasksWidget.kind, TrackWidget.kind]
    for kind in all where kind != tappedKind {
        reloadOpenTaskWidget(kind: kind)
    }
    reloadTappedWidget(kind: tappedKind)
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
        await reloadTappedWidget(kind: kind)
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
        // Restored before its completion was ever sent (the outbox,
        // 2026-09-30 — a Tasks check-off is drawn in DONE while still
        // queued): take the queued completion back locally. The server never
        // heard of it, so there is nothing to restore there.
        if let cancelled = WidgetStore.cancelQueuedOutboxEntry(where: {
            if case .complete(let id, _) = $0 { return id == taskId }
            return false
        }) {
            WidgetStore.revertOptimisticState(of: cancelled)
            WidgetStore.forgetLocalMutationForUndoCount()
            WidgetStore.markInteraction()
            await reloadTappedWidget(kind: kind)
            return .result()
        }
        // A completion mid-send (or queued behind a failure) must reach the
        // server before its restore, or `/undone` finds nothing to undo.
        await widgetOutbox.drain()

        // Optimistic (§8): tombstone it out of the DONE list and repaint
        // from cache before the server call — same discipline as
        // CompleteTaskIntent's own tombstone. `markInteraction()` matters
        // here specifically: `pendingRestores` isn't one of the sources
        // `hasRecentInteraction()` consults (unlike `pendingCompletions`),
        // so without this stamp round 1's reload would pay a real network
        // fetch instead of painting the tombstone instantly.
        WidgetStore.stagePendingRestore(taskId)
        WidgetStore.markInteraction()
        await reloadTappedWidget(kind: kind)

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
        await reloadTappedWidget(kind: kind)
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
// (`Shared/TaskSnoozePlan.swift`, pure and harness-tested), which also turns a
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
        await reloadTappedWidget(kind: TasksWidget.kind)
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
        await reloadTappedWidget(kind: TasksWidget.kind)
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
        await reloadTappedWidget(kind: TasksWidget.kind)
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
        let scope = TasksTimeline.currentScope()
        var ids = WidgetStore.selectedTaskIds(for: scope)
        if ids.contains(taskId) {
            ids.remove(taskId)
        } else {
            ids.insert(taskId)
        }
        WidgetStore.setSelectedTaskIds(ids, for: scope)
        WidgetStore.markInteraction()
        await reloadTappedWidget(kind: TasksWidget.kind)
        return .result()
    }
}

/// Send a `TaskSnoozePlan`'s requests (`TaskSnoozePlan.send`, shared with
/// the watch app — sequential, returns the ids that actually moved), bumping
/// the Undo/Redo affordance's local count once per request that landed —
/// one server undo entry each.
private func sendSnoozeRequests(_ requests: [TaskSnoozePlan.Request]) async -> Set<Int> {
    await TaskSnoozePlan.send(requests) { _ in
        WidgetStore.recordLocalMutationForUndoCount()
    }
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
        let scope = TasksTimeline.currentScope()
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
        await reloadTappedWidget(kind: TasksWidget.kind)
        return .result()
    }
}

/// Complete every currently-selected task at once — the select-mode bottom
/// bar's "✓ Done". `POST /api/tasks/bulk/complete` (the SAME endpoint the
/// SLOT_REMINDER notification checklist already uses — see `ios/AGENTS.md`'s
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
        let scope = TasksTimeline.currentScope()
        let ids = Array(WidgetStore.selectedTaskIds(for: scope))
        guard !ids.isEmpty else { return .result() }

        for id in ids { WidgetStore.stagePendingCompletion(id) }
        WidgetStore.markInteraction()
        await reloadTappedWidget(kind: TasksWidget.kind)

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
        await reloadTappedWidget(kind: TasksWidget.kind)
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
        await reloadTappedWidget(kind: TasksWidget.kind)
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
        await reloadTappedWidget(kind: TasksWidget.kind)
        return .result()
    }
}
