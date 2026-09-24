import Foundation
import WidgetKit
import WatchKit

/// Single source of truth for all three pages (`RemindersPageView`,
/// `TasksPageView`, `QuotasPageView`).
///
/// Deliberately simpler than the phone widgets' `WidgetStore` optimistic
/// pipeline (staged deltas, tombstone TTLs, auto-advance snapshots): the
/// watch app is a live, foregrounded SwiftUI view with a real event loop, not
/// a WidgetKit timeline that has to fake responsiveness between reloads. A
/// completion hides the row immediately (`@Published` removal) and
/// reconciles against a real fetch a moment later; a snooze just calls the
/// API and refetches; a quota tap stages a net delta and writes the
/// server's returned count (`logQuota`/`settleQuota` — the one piece of
/// per-tap bookkeeping here, because rapid quota taps must all draw and the
/// count must end server-true). No TTLs: there's no "next timeline entry"
/// to hide behind.
@MainActor
final class WatchViewModel: ObservableObject {
    @Published private(set) var reminderGroups: [ReminderGroupDTO] = []
    @Published private(set) var tasks: [TaskDTO] = []
    @Published private(set) var projects: [ProjectDTO] = []
    /// Label display colors for the Quotas page's stripes (`GET /api/user/
    /// preferences`' `label_config` — see `APIClient.fetchLabelConfig`'s doc
    /// for why not `/api/labels`).
    @Published private(set) var labelConfig: [LabelConfigDTO] = []
    /// The Quotas page's "Show met" toggle, persisted in `WatchCache`.
    @Published var showMetQuotas: Bool = WatchCache.showMetQuotas {
        didSet { WatchCache.showMetQuotas = showMetQuotas }
    }
    /// Quotas' Takeback mode (2026-09-24) — the phone Quotas widget's model
    /// (`WidgetStore.quotasTakebackMode`), ported: the page's ⊖ toolbar
    /// toggle arms it; while on, every tap is `−1`, rows at 0 are dimmed and
    /// disabled, and met quotas show whatever "Show met" says (so they can
    /// be taken back). It STAYS ON across `−1`s — Trent found auto-exit
    /// after one "weird" on the phone (3/3 → 0/3 meant re-arming before
    /// every tap) — until the toggle is tapped again.
    ///
    /// Not persisted, and cleared when the Quotas page is left or the app
    /// goes to the background (`QuotasPageView.onDisappear`,
    /// `WatchRootView`'s scene-phase handler): the phone clears it on any
    /// timeline built outside its own taps, so an armed mode never outlives
    /// the moment it was armed for; a live view's equivalent is "you walked
    /// away from it".
    @Published var quotasTakebackMode = false
    /// Net `+1`/`−1` taps per quota whose server round trip is still in
    /// flight (`logQuota`). Drawn on top of the server's count (`quotas`),
    /// so rapid taps all show; each tap retires exactly its own delta when
    /// its response lands (`settleQuota`). The same shape as the phone's
    /// staged progress (`WidgetStore.stagePendingProgress`).
    @Published private(set) var pendingQuotaDeltas: [Int: Int] = [:]
    /// Bumped on every `settleQuota`; `settledAt[id]` is the value it had
    /// when that quota's count was last written from a tap response.
    /// `load()` notes the counter when it STARTS, and keeps our copy of any
    /// quota settled after that — a fetch sent before the server applied a
    /// tap can land after the tap's response and would otherwise put the
    /// pre-tap count back (the phone's "a fetch that STARTED after" rule,
    /// `ios/CLAUDE.md`'s stale-count note).
    private var settleCounter = 0
    private var settledAt: [Int: Int] = [:]
    /// Quotas that had two or more taps in flight at once. Their responses
    /// can arrive out of order (last response wins in `settleQuota`), so
    /// once the last one settles, one real fetch confirms the count.
    private var overlappedQuotaIds: Set<Int> = []
    @Published private(set) var isLoading = false
    @Published private(set) var loadError: String?
    /// Whether `load()` has completed at least once. Both pages gate their
    /// empty state on this — without it, "All caught up" / "No reminders
    /// configured yet" flash on screen for the first ~1-3s of every launch,
    /// before the first fetch has actually landed, which reads as false
    /// reassurance rather than "no empty chrome" (Trent's rule is about
    /// chrome with nothing to show, not about lying while data is still in
    /// flight).
    @Published private(set) var hasLoadedOnce = false
    @Published private(set) var canUndo = false
    /// Shown in place of the Reminders header subtitle for a few seconds after
    /// an undo, same idea as the phone widgets' "Undid: …" (§ widgets doc) —
    /// simplified to a plain timed clear rather than a scheduled timeline entry,
    /// since this view is live and can just fire a `Task.sleep`.
    @Published private(set) var lastActionDescription: String?

    /// Manual override for the Reminders page's on-screen slot, set by the
    /// ‹ › controls. `nil` means "follow the natural (current) slot" — the
    /// moment new data loads with a different natural slot, the override is
    /// NOT auto-cleared (unlike the phone widget's auto-advance): the watch
    /// has no slot-completion auto-advance requirement in this task's scope,
    /// so a user who has manually paged away stays there until they page
    /// again or relaunch. Clamped into range by `displayedSlotIndex`.
    @Published var slotOverride: Int?

    private let api = APIClient.shared

    var isConfigured: Bool { api.isConfigured }

    /// The slot index actually on screen: the manual override if one is set
    /// and still in range, else the natural (current-time) slot.
    var displayedSlotIndex: Int {
        if let override = slotOverride, reminderGroups.indices.contains(override) {
            return override
        }
        return WatchSlotLogic.naturalSlotIndex(in: reminderGroups)
    }

    var displayedGroup: ReminderGroupDTO? {
        reminderGroups.indices.contains(displayedSlotIndex) ? reminderGroups[displayedSlotIndex] : nil
    }

    var upNextTasks: [TaskDTO] { WatchSlotLogic.upNextTasks(from: tasks) }
    var overdueTasks: [TaskDTO] { WatchSlotLogic.overdueTasks(from: tasks) }
    /// Every open quota — the same `isTracked` slice of `/api/tasks` the
    /// phone Quotas widget reads (quotas are open tasks that never complete,
    /// so no separate endpoint exists or is needed).
    ///
    /// Each count is the server's (the last fetch, or the task the server
    /// returned for the last settled tap) plus any still-in-flight taps
    /// (`pendingQuotaDeltas`), floored at 0 like the server.
    var quotas: [TaskDTO] {
        tasks.filter(\.isTracked).map { task in
            guard let delta = pendingQuotaDeltas[task.id] else { return task }
            return task.withOptimisticIncrement(delta)
        }
    }

    /// Met quotas are hidden unless "Show met" is on OR Takeback mode is
    /// armed (a met quota has to be visible to be taken back — the phone
    /// widget's `showMet || takeback`). With both off, a `+1` that meets a
    /// quota makes its row vanish on that tap — no grace period, the phone's
    /// rule since PR #65 (a met row left under the finger just gets
    /// over-tapped).
    var quotaSections: [WatchQuotaSection] {
        WatchQuotaLogic.sections(
            quotas: quotas,
            labelConfig: labelConfig,
            showMet: showMetQuotas || quotasTakebackMode
        )
    }

    func project(for task: TaskDTO) -> ProjectDTO? {
        projects.first { $0.id == task.projectId }
    }

    // MARK: - Load

    /// Fetch everything the three pages need in one pass, in parallel. Falls
    /// back to the last-known `WatchCache` payload on failure (e.g. dev
    /// server unreachable) rather than blanking the screen — same "stale
    /// beats empty" instinct as the phone widgets, just without their TTL.
    func load() async {
        guard isConfigured else { return }
        isLoading = true
        loadError = nil
        // See `settleCounter`: quotas settled after this point keep our copy.
        let settleCounterAtStart = settleCounter

        async let remindersResult = asyncResult { try await api.fetchReminders() }
        async let tasksResult = asyncResult { try await api.fetchOpenTasks() }
        async let projectsResult = asyncResult { try await api.fetchProjects() }
        async let undoResult = asyncResult { try await api.fetchUndoStatus() }
        async let labelsResult = asyncResult { try await api.fetchLabelConfig() }

        let (rem, tsk, proj, undo, labels) = await (
            remindersResult, tasksResult, projectsResult, undoResult, labelsResult
        )

        if case let .success(payload) = rem {
            reminderGroups = payload.groups
            WatchCache.saveReminders(payload.groups)
        } else if let cached = WatchCache.loadReminders() {
            reminderGroups = cached
        }

        if case let .success(fetched) = tsk, case let .success(proj) = proj {
            // A quota with a tap still in flight, or one whose tap response
            // landed after this fetch was SENT, keeps the count we already
            // hold: this fetch may or may not include that tap (it can land
            // either side of the server applying it). Drawing a pending delta
            // over a count that already has it would show the tap twice, and
            // taking a pre-tap count over a settled one would undo the
            // server-true write. The tap's own response (`settleQuota`) is
            // the authority for that quota.
            func keepsOurs(_ id: Int) -> Bool {
                pendingQuotaDeltas[id] != nil || (settledAt[id] ?? Int.min) > settleCounterAtStart
            }
            var openTasks = fetched
            if fetched.contains(where: { keepsOurs($0.id) }) {
                let held = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
                openTasks = fetched.map { task in
                    guard keepsOurs(task.id), let mine = held[task.id] else { return task }
                    return mine
                }
            }
            tasks = openTasks
            projects = proj
            WatchCache.saveTasks(openTasks, projects: proj)
        } else if let cached = WatchCache.loadTasks() {
            tasks = cached.tasks
            projects = cached.projects
        }

        if case let .success(status) = undo {
            canUndo = status.undoableCount > 0
        }

        // Colors only — a failure falls back to the cached config (or none:
        // every stripe draws neutral), never to an error state.
        if case let .success(config) = labels {
            labelConfig = config
            WatchCache.saveLabelConfig(config)
        } else if let cached = WatchCache.loadLabelConfig() {
            labelConfig = cached
        }

        // Surface a failure on EITHER fetch, not just reminders — the
        // Reminders and Tasks pages read the same `loadError`, so a
        // tasks-only failure (reminders fine, tasks/projects not) used to be
        // silent on the Tasks page even with nothing to show. Only reported
        // when there's no cache to fall back on for the failing side, so a
        // transient blip while a cached payload still renders stays quiet.
        let remindersFailed = { if case .failure = rem { return true }; return false }()
        let tasksFailed = { if case .failure = tsk { return true }; return false }()
        if remindersFailed, WatchCache.loadReminders() == nil {
            if case .failure(let error) = rem { loadError = error.localizedDescription }
        } else if tasksFailed, WatchCache.loadTasks() == nil {
            if case .failure(let error) = tsk { loadError = error.localizedDescription }
        }

        isLoading = false
        hasLoadedOnce = true
        // Keep the Smart Stack card in step with what the app just saw: a
        // change made elsewhere (web, phone) otherwise waits for the widget's
        // own ~20 min refresh. Reloads requested by a foreground app don't
        // count against the widget's budget. Its relevance hints are computed
        // from the cache this just wrote (`ReminderStackProvider.relevance()`),
        // so ask the system to re-read those too.
        WidgetCenter.shared.reloadTimelines(ofKind: WatchWidgetState.kind)
        if #available(watchOS 11.0, *) {
            WidgetCenter.shared.invalidateRelevance(ofKind: WatchWidgetState.kind)
        }
    }

    // MARK: - Reminders

    /// Tap-to-consider: optimistic removal + haptic, then reconcile. The
    /// removal is a real mutation of `@Published` state (not a tombstone
    /// flag), which is safe here because this is a live view, not a
    /// redraw-from-cache WidgetKit timeline — if the server call fails, the
    /// reload below (`load()`) simply restores it from truth.
    func completeReminder(_ task: TaskDTO) {
        guard let idx = reminderGroups.firstIndex(where: { $0.reminders.contains(where: { $0.id == task.id }) })
        else { return }
        // `ReminderGroupDTO.reminders` is a `let` (Shared/OpenTaskModels.swift
        // — the type is immutable by design, mirrored into the widget's App
        // Group cache verbatim), so the removal rebuilds the group via its
        // memberwise init rather than mutating in place.
        let group = reminderGroups[idx]
        reminderGroups[idx] = ReminderGroupDTO(
            slot: group.slot,
            reminders: group.reminders.filter { $0.id != task.id },
            considered: group.considered + 1
        )
        WKInterfaceDevice.current().play(.click)

        Task {
            do {
                try await api.markDone(taskId: task.id)
                WKInterfaceDevice.current().play(.success)
                WidgetCenter.shared.reloadAllTimelines()
            } catch {
                WKInterfaceDevice.current().play(.failure)
            }
            await load()
        }
    }

    // MARK: - Tasks

    func completeTask(_ task: TaskDTO) {
        tasks.removeAll { $0.id == task.id }
        WKInterfaceDevice.current().play(.click)

        Task {
            do {
                try await api.markDone(taskId: task.id)
                WKInterfaceDevice.current().play(.success)
                WidgetCenter.shared.reloadAllTimelines()
            } catch {
                WKInterfaceDevice.current().play(.failure)
            }
            await load()
        }
    }

    /// Snooze one task from the Tasks page's touch-and-hold chooser —
    /// "Next period" or "+1 hour", by the SAME due-relative rule as the
    /// phone Tasks widget's per-row snooze (`TaskSnoozePlan`, shared in
    /// `ios/Shared/`): base = max(now, due). An UPCOMING task's +1h is its
    /// own due + 60 min (a `delta_minutes: 60` request) and its Next period
    /// is the first slot start after its due time; an overdue one's +1h is
    /// one hour from now, snapped, and its Next period the next slot from
    /// now. Sent through `POST /api/tasks/bulk/snooze` with
    /// `include_task_ids: [id]` (an explicit tap bypasses the P3/P4 sweep
    /// filter), exactly like the phone.
    ///
    /// Before 2026-09-24 this was two methods that both counted from NOW
    /// (`PATCH` to the next slot from now; the notification action's
    /// `snapToHour(now + 60)`) — Trent's "+1 hour on a 5 PM task moved it
    /// to 11 AM" bug, still live here after the phone was fixed.
    ///
    /// No optimistic removal (the phone stages nothing for snoozes either):
    /// an upcoming task snoozed +1h stays in "Up next", so hiding it and
    /// re-adding it on reload would just flicker. The reload redraws it at
    /// its new time. Slots come from `TimeSlotStore` (refreshed on every
    /// launch/foreground by `WatchAppDelegate`'s `refreshSlotActions()`);
    /// Next period with no cached slots plans nothing → failure haptic,
    /// nothing sent.
    func snoozeTask(_ task: TaskDTO, target: TaskSnoozeTarget) {
        let requests = TaskSnoozePlan.requests(
            target,
            tasks: [(id: task.id, dueAt: task.dueDate)],
            now: Date(),
            slots: TimeSlotStore.cachedSlots
        )
        guard !requests.isEmpty else {
            WKInterfaceDevice.current().play(.failure)
            return
        }
        WKInterfaceDevice.current().play(.click)
        Task {
            let moved = await TaskSnoozePlan.send(requests)
            if moved.contains(task.id) {
                WKInterfaceDevice.current().play(.success)
                canUndo = true
                WidgetCenter.shared.reloadAllTimelines()
            } else {
                WKInterfaceDevice.current().play(.failure)
            }
            await load()
        }
    }

    // MARK: - Quotas

    /// Tap on a quota row: `+1`, or `−1` while Takeback mode is armed —
    /// the phone Quotas widget's model (`IncrementProgressIntent`, 2026-09-24).
    /// Outside the mode EVERY row is `+1`, a met one included (visible only
    /// with "Show met" on), so over-target counts like "2/1" are allowed —
    /// deliberately, matching the phone and the web panel (whose chip tap is
    /// an unconditional `log(1)`). Before 2026-09-24 a tap on a met row was
    /// a silent `−1`; Takeback mode replaced that. The same
    /// `POST /api/tasks/:id/progress` (`APIClient.logProgress`, server floors
    /// at 0), in the server's undo log like every mutation here.
    ///
    /// Optimistic, then SERVER-TRUE: the tap's delta is staged
    /// (`pendingQuotaDeltas`, drawn by `quotas`) before the round trip, and
    /// the task the endpoint returns is written into `tasks` (and
    /// `WatchCache`) in the same main-actor step that retires the delta —
    /// the count on screen after the tap is the server's, never "old count
    /// with the delta removed". That was the phone widget's stale-count bug
    /// (2026-09-24, `WidgetStore.confirmProgress`): it retired the delta
    /// without writing the response, and drew the pre-tap count back.
    /// No `load()` on success — a full refetch racing a second quick tap
    /// could redraw the count from before it.
    func logQuota(_ task: TaskDTO) {
        let delta = quotasTakebackMode ? -1 : 1
        let shown = quotas.first { $0.id == task.id }?.progressCurrent ?? task.progressCurrent
        // Takeback rows at 0 are disabled; this is the same rule for a tap
        // that lands anyway (nothing to take back — the server would floor
        // it, but it would still cost an undo entry).
        if delta < 0, shown <= 0 { return }
        if pendingQuotaDeltas[task.id] != nil { overlappedQuotaIds.insert(task.id) }
        pendingQuotaDeltas[task.id, default: 0] += delta
        WKInterfaceDevice.current().play(delta > 0 ? .click : .directionDown)

        Task {
            do {
                let confirmed = try await api.logProgress(taskId: task.id, delta: delta)
                settleQuota(task.id, delta: delta, confirmed: confirmed)
                WKInterfaceDevice.current().play(.success)
                canUndo = true
                WidgetCenter.shared.reloadAllTimelines()
                // Logged, but the body didn't decode: nothing trustworthy to
                // draw, so fetch the truth.
                if confirmed == nil { await load() }
            } catch {
                // Usually nothing changed server-side and `tasks` still holds
                // the pre-tap count, so retiring the delta is the revert. But
                // a timeout can fire after the server committed, so fetch the
                // truth either way.
                settleQuota(task.id, delta: delta, confirmed: nil)
                WKInterfaceDevice.current().play(.failure)
                await load()
            }
        }
    }

    /// Retire one tap's staged delta and, when the server answered with the
    /// task, write that count in — one synchronous step, so no render ever
    /// sees the server's new count AND the still-staged delta (the tap
    /// counted twice). A sibling tap still in flight keeps its own delta,
    /// drawn over the server's count.
    ///
    /// Out-of-order responses (two overlapping taps on one quota, the later
    /// one answered first) can draw one step high for a moment and then
    /// settle one step behind — last response wins. So a quota that had
    /// overlapping taps gets one `load()` once its last tap settles, which
    /// replaces the count with a fetch sent after every one of them landed.
    private func settleQuota(_ id: Int, delta: Int, confirmed: TaskDTO?) {
        if let confirmed, let idx = tasks.firstIndex(where: { $0.id == id }) {
            tasks[idx] = confirmed
            WatchCache.saveTasks(tasks, projects: projects)
            settleCounter += 1
            settledAt[id] = settleCounter
        }
        let remaining = (pendingQuotaDeltas[id] ?? 0) - delta
        if remaining == 0 {
            pendingQuotaDeltas.removeValue(forKey: id)
            if overlappedQuotaIds.remove(id) != nil {
                Task { await load() }
            }
        } else {
            pendingQuotaDeltas[id] = remaining
        }
    }

    // MARK: - Bulk overdue

    /// Snooze every overdue task (server-side set, not just what's on
    /// screen) to the next period. P3 (High) is only included once nothing
    /// lower is left in the sweep, P4 (Urgent) never — see `bulkSnooze()` /
    /// `docs/TASK-MODEL.md`'s due-date philosophy. Same endpoint the
    /// notification "All → Next period" action and the phone's clock button
    /// use.
    ///
    /// `async`, returning the server's real result (`nil` on failure) rather
    /// than firing-and-forgetting internally — `BulkSnoozeSheetView` awaits
    /// this so it can show what actually happened (N snoozed, High included,
    /// Urgent still overdue) instead of just closing on tap and hoping.
    @discardableResult
    func bulkSnoozeOverdueNextPeriod() async -> APIClient.BulkSnoozeResult? {
        WKInterfaceDevice.current().play(.click)
        do {
            let result = try await api.snoozeOverdue(slot: "next")
            WKInterfaceDevice.current().play(result.tasksAffected > 0 ? .success : .failure)
            WidgetCenter.shared.reloadAllTimelines()
            await load()
            return result
        } catch {
            WKInterfaceDevice.current().play(.failure)
            await load()
            return nil
        }
    }

    @discardableResult
    func bulkSnoozeOverduePlusHour() async -> APIClient.BulkSnoozeResult? {
        WKInterfaceDevice.current().play(.click)
        do {
            let result = try await api.snoozeOverdue(deltaMinutes: 60)
            WKInterfaceDevice.current().play(result.tasksAffected > 0 ? .success : .failure)
            WidgetCenter.shared.reloadAllTimelines()
            await load()
            return result
        } catch {
            WKInterfaceDevice.current().play(.failure)
            await load()
            return nil
        }
    }

    // MARK: - Undo

    /// Same server-wide "undo whatever changed last" endpoint the phone
    /// widgets' Undo button calls — see `APIClient.undoLastAction`'s doc for
    /// why it carries no task id.
    func undo() {
        guard canUndo else { return }
        WKInterfaceDevice.current().play(.click)
        Task {
            do {
                let result = try await api.undoLastAction()
                lastActionDescription = "Undid: \(result.description)"
                canUndo = result.undoableCount > 0
                WKInterfaceDevice.current().play(.success)
                WidgetCenter.shared.reloadAllTimelines()
                await load()
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if lastActionDescription == "Undid: \(result.description)" {
                    lastActionDescription = nil
                }
            } catch {
                WKInterfaceDevice.current().play(.failure)
            }
        }
    }
}

#if DEBUG
extension WatchViewModel {
    /// A model pre-filled with `WatchPreviewData` (Trent's real quotas) for
    /// `#Preview`s — no network, `hasLoadedOnce` already true so the page
    /// renders content instead of its first-launch spinner. Lives in this
    /// file because the properties it fills are `private(set)`. Setting
    /// `showMetQuotas` persists through its `didSet`, which is harmless in a
    /// preview process (its App Group defaults are its own sandbox).
    static func preview(showMet: Bool, takeback: Bool = false) -> WatchViewModel {
        let model = WatchViewModel()
        model.tasks = WatchPreviewData.quotas
        model.labelConfig = WatchPreviewData.labelConfig
        model.hasLoadedOnce = true
        model.canUndo = true
        model.showMetQuotas = showMet
        model.quotasTakebackMode = takeback
        return model
    }
}
#endif

/// Small `Result`-from-async helper so `load()` can fan out five requests in
/// parallel with `async let` and still fall back per-endpoint on failure,
/// without five separate do/catch blocks. A free function rather than a
/// `Result.init(catching:)` extension to avoid any overload ambiguity with
/// the stdlib's synchronous `init(catching:)` at call sites that use trailing
/// closure syntax.
private func asyncResult<T>(_ body: () async throws -> T) async -> Result<T, Error> {
    do {
        return .success(try await body())
    } catch {
        return .failure(error)
    }
}
