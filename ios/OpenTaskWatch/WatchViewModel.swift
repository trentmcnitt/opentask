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
/// tap here hides the row immediately (`@Published` removal) and reconciles
/// against a real fetch a moment later — no cache TTL bookkeeping needed
/// because there's no "next timeline entry" to hide behind.
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
    /// Quotas logged from the Quotas page since it was last shown — kept
    /// visible even once met, so a +1 that completes a quota doesn't pull
    /// the row (and the −1 that would take it back) out from under the
    /// finger. Cleared when the page is left (`QuotasPageView`'s
    /// `.onDisappear`), never on a timer — see `WatchQuotaLogic.sections`.
    @Published private(set) var recentlyLoggedQuotaIds: Set<Int> = []
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
    var quotas: [TaskDTO] { tasks.filter(\.isTracked) }

    var quotaSections: [WatchQuotaSection] {
        WatchQuotaLogic.sections(
            quotas: quotas,
            labelConfig: labelConfig,
            showMet: showMetQuotas,
            keepVisible: recentlyLoggedQuotaIds
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

        if case let .success(openTasks) = tsk, case let .success(proj) = proj {
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

    /// Snooze one task to the next time slot's start. Computed on-device
    /// (`WatchSlotLogic.nextPeriodDate`) and sent as an absolute `due_at` via
    /// `PATCH /api/tasks/:id` (`APIClient.snoozeTo`) — there is no
    /// single-task "slot: next" endpoint; only the bulk overdue sweep
    /// resolves that keyword server-side. See `WatchSlotLogic.
    /// nextPeriodDate`'s doc for why this can't reuse that endpoint here.
    func snoozeTaskToNextPeriod(_ task: TaskDTO) {
        guard let target = WatchSlotLogic.nextPeriodDate() else {
            WKInterfaceDevice.current().play(.failure)
            return
        }
        tasks.removeAll { $0.id == task.id }
        WKInterfaceDevice.current().play(.click)
        Task {
            do {
                try await api.snoozeTo(taskId: task.id, dueAt: DateHelpers.formatISO(target))
                WKInterfaceDevice.current().play(.success)
                WidgetCenter.shared.reloadAllTimelines()
            } catch {
                WKInterfaceDevice.current().play(.failure)
            }
            await load()
        }
    }

    /// Snooze one task by the same "+1 hour, snapped to the hour" rule the
    /// notification actions use (`snoozeNextHour` → `/api/notifications/
    /// actions` action `"snooze"` → `snapToHour(now + 60min)` server-side).
    func snoozeTaskPlusHour(_ task: TaskDTO) {
        tasks.removeAll { $0.id == task.id }
        WKInterfaceDevice.current().play(.click)
        Task {
            do {
                try await api.snoozeNextHour(taskId: task.id)
                WKInterfaceDevice.current().play(.success)
                WidgetCenter.shared.reloadAllTimelines()
            } catch {
                WKInterfaceDevice.current().play(.failure)
            }
            await load()
        }
    }

    // MARK: - Quotas

    /// Tap on a quota row: +1 while it's under target, −1 once it's met
    /// ("take back" — a met quota is done, so the only useful tap on it is
    /// correcting a mis-log). The same `POST /api/tasks/:id/progress` the
    /// phone widget's `IncrementProgressIntent` sends (`APIClient.
    /// logProgress`, server floors at 0), and like every other mutation here
    /// it lands in the server's undo log, so the toolbar Undo reverts it.
    ///
    /// Optimistic: the row's count moves before the round trip (via
    /// `withOptimisticIncrement`, the same helper the phone widget uses), then
    /// `load()` reconciles against the server either way — a failure simply
    /// redraws the true count.
    func logQuota(_ task: TaskDTO) {
        let delta = task.isProgressMet ? -1 : 1
        guard let idx = tasks.firstIndex(where: { $0.id == task.id }) else { return }
        tasks[idx] = tasks[idx].withOptimisticIncrement(delta)
        recentlyLoggedQuotaIds.insert(task.id)
        WKInterfaceDevice.current().play(delta > 0 ? .click : .directionDown)

        Task {
            do {
                try await api.logProgress(taskId: task.id, delta: delta)
                WKInterfaceDevice.current().play(.success)
                canUndo = true
                WidgetCenter.shared.reloadAllTimelines()
            } catch {
                WKInterfaceDevice.current().play(.failure)
            }
            await load()
        }
    }

    /// Leaving the Quotas page ends the "just logged" grace: next time it is
    /// shown, met quotas are hidden again per the toggle.
    func clearRecentlyLoggedQuotas() {
        recentlyLoggedQuotaIds.removeAll()
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
    static func preview(showMet: Bool) -> WatchViewModel {
        let model = WatchViewModel()
        model.tasks = WatchPreviewData.quotas
        model.labelConfig = WatchPreviewData.labelConfig
        model.hasLoadedOnce = true
        model.canUndo = true
        model.showMetQuotas = showMet
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
