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
    /// Today's task segments (2026-10-10), as the server sent them — kept
    /// apart from `reminderGroups`, never merged into a group. Read them
    /// through `listedSegments`, which draws in-flight considers.
    @Published private(set) var taskSegments: [TaskSegmentDTO] = []
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
    /// `ios/AGENTS.md`'s stale-count note).
    private var settleCounter = 0
    private var settledAt: [Int: Int] = [:]
    /// Quotas that had two or more taps in flight at once. Their responses
    /// can arrive out of order (last response wins in `settleQuota`), so
    /// once the last one settles, one real fetch confirms the count.
    private var overlappedQuotaIds: Set<Int> = []
    @Published private(set) var isLoading = false
    @Published private(set) var loadError: String?
    /// Whether `load()` has completed at least once. Both pages gate their
    /// empty state on this — without it, "Complete" / "No reminders
    /// configured yet" flash on screen for the first ~1-3s of every launch,
    /// before the first fetch has actually landed, which reads as false
    /// reassurance rather than "no empty chrome" (Trent's rule is about
    /// chrome with nothing to show, not about lying while data is still in
    /// flight).
    @Published private(set) var hasLoadedOnce = false
    /// The toolbar Undo's enabled state (scoped since 2026-10-26,
    /// `UndoScope`): only while the watch's OWN last action — this app's or
    /// its Smart Stack card's (`WatchCache.undoScope`) — is the server's
    /// newest undoable entry. Against an older server, the server's undoable
    /// count, as before. Kept in step by `refreshUndo()`.
    @Published private(set) var canUndo = false
    /// The server's undoable count — the older server's rule.
    private var legacyUndoable = 0
    /// Shown in place of the Reminders header subtitle for a few seconds after
    /// an undo, same idea as the phone widgets' "Undid: …" (§ widgets doc) —
    /// simplified to a plain timed clear rather than a scheduled timeline entry,
    /// since this view is live and can just fire a `Task.sleep`.
    @Published private(set) var lastActionDescription: String?

    /// Manual override for the Reminders page's on-screen slot, set by the
    /// ‹ › controls. `nil` means "follow the default page" — the moment new
    /// data loads with a different default, the override is NOT auto-cleared
    /// (unlike the phone widget's, which is anchored to the default it was
    /// made against): the watch has no slot-completion auto-advance, so a
    /// user who has manually paged away stays there until they page again
    /// or relaunch. Clamped into range by `displayedSlotIndex`.
    @Published var slotOverride: Int?

    private let api = APIClient.shared

    var isConfigured: Bool { api.isConfigured }

    /// The slot index actually on screen: the manual override if one is set
    /// and still in range, else the default page's period.
    ///
    /// The default is the phone widget's rule, `ReminderDefaultPage.key`
    /// (Trent's ruling 2026-10-27; ios/Shared): Deadlines while it has an
    /// unseen row, else the earliest opened period with something waiting,
    /// else the first waiting queue segment, else — everything done — the
    /// latest opened period, completed (Trent, 10-27). The watch pages
    /// through PERIODS only — every task segment is listed under whichever
    /// period is on screen — so when the rule answers a segment (rules 1 and
    /// 3) the page shows the clock's period with the segments under it, as
    /// before; when it answers a period (rules 2 and 5), that period.
    var displayedSlotIndex: Int {
        if let override = slotOverride, reminderGroups.indices.contains(override) {
            return override
        }
        let now = Date()
        let day = DayStartStore.current
        let key = ReminderDefaultPage.key(groups: reminderGroups, segments: listedSegments, now: now, day: day)
        if let key, let index = reminderGroups.firstIndex(where: { $0.slotKey == key }) {
            return index
        }
        return WatchSlotLogic.naturalSlotIndex(in: reminderGroups, now: now, day: day)
    }

    var displayedGroup: ReminderGroupDTO? {
        reminderGroups.indices.contains(displayedSlotIndex) ? reminderGroups[displayedSlotIndex] : nil
    }

    var upNextTasks: [TaskDTO] { WatchSlotLogic.upNextTasks(from: tasks) }
    var overdueTasks: [TaskDTO] { WatchSlotLogic.overdueTasks(from: tasks) }
    /// How many the overdue sweep would move — the phone's and the Mac's
    /// estimate (`TaskLists.overdueSweepEligibleCount`; one High per press
    /// with the task queue on, as this watch last cached it). The Tasks
    /// button's "Defer 2 of 3" (`OverdueSweepWords`, 2026-10-26).
    var overdueSweepCount: Int {
        TaskLists.overdueSweepEligibleCount(tasks, taskQueue: DayStartStore.cachedTaskQueue)
    }
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
        // A status sent before a tap must not dim the Undo that tap lit
        // (`UndoScope.apply`'s race note).
        let loadStartedAt = Date()
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
            reminderGroups = overlayingPendingPrompts(payload.groups)
            WatchCache.saveReminders(payload.groups)
            taskSegments = payload.taskSegments
            WatchCache.saveTaskSegments(payload.taskSegments)
        } else if let cached = WatchCache.loadReminders() {
            reminderGroups = overlayingPendingPrompts(cached)
            taskSegments = WatchCache.loadTaskSegments()
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
            legacyUndoable = status.undoableCount
            WatchCache.updateUndoScope {
                $0.apply(
                    newestUndoable: status.newestUndoableId, nextRedoable: status.nextRedoableId,
                    scoped: status.scoped, requestedAt: loadStartedAt
                )
            }
        }
        refreshUndo()

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
        // Carries `consideredItems` (the done reminder joins them) and
        // `prompts` through — this rebuild used to drop `consideredItems`
        // until the next fetch (pre-existing; fixed with quota prompts).
        let group = reminderGroups[idx]
        reminderGroups[idx] = ReminderGroupDTO(
            slot: group.slot,
            reminders: group.reminders.filter { $0.id != task.id },
            considered: group.considered + 1,
            consideredItems: [task] + group.consideredItems,
            prompts: group.prompts
        )
        WKInterfaceDevice.current().play(.click)

        Task {
            do {
                try await api.markDone(taskId: task.id)
                // No success chime (Trent, 2026-10-11): the tap's single
                // click is the whole feedback, as on a segment row; only a
                // failure buzzes.
                WidgetCenter.shared.reloadAllTimelines()
            } catch {
                WKInterfaceDevice.current().play(.failure)
            }
            await load()
        }
    }

    // MARK: - Task segments (2026-10-10, docs/TASK-MODEL.md § Task segments)

    /// Considers whose round trip is still in flight — drawn considered over
    /// every payload, so a fetch that lands mid-flight can't flash the row
    /// back (the `pendingPromptActions` rule).
    @Published private var pendingSegmentConsiders: Set<Int> = []

    /// Every segment the server sent (`?fill=1`, native PR E — empty ones
    /// too), in screen order, with in-flight considers drawn (a safety-net
    /// row SEEN, still waiting — `consideredByTap`). The Reminders page
    /// shows each one that still has a row waiting under the time slot's
    /// rows, and the deadlines page always (`TaskSegmentSection`).
    var listedSegments: [TaskSegmentDTO] {
        let drawn = pendingSegmentConsiders.isEmpty ? taskSegments : taskSegments.map { segment in
            segment.replacingTasks(segment.tasks.map {
                pendingSegmentConsiders.contains($0.id) && $0.isConsiderable ? $0.consideredByTap() : $0
            })
        }
        return TaskSegmentDTO.listed(drawn)
    }

    /// Edit one row of the live segments: a new state, or nil to drop it.
    private func setSegmentRow(_ taskId: Int, state: SegmentTaskDTO.State?) {
        editSegmentRow(taskId) { row in state.map { row.with(state: $0) } }
    }

    /// Any edit of one row of the live segments; nil drops it.
    private func editSegmentRow(_ taskId: Int, _ edit: (SegmentTaskDTO) -> SegmentTaskDTO?) {
        taskSegments = taskSegments.map { segment in
            segment.replacingTasks(segment.tasks.compactMap { row in row.id == taskId ? edit(row) : row })
        }
    }

    /// The row as it is now, to put back if a tap fails.
    private func segmentRow(_ taskId: Int) -> SegmentTaskDTO? {
        taskSegments.lazy.flatMap(\.tasks).first { $0.id == taskId }
    }

    /// The circle (or a tap on the row): "I saw it" — `POST
    /// /api/task-segments/consider`, never a completion.
    ///
    /// Instant, for rapid-fire use (Trent, 2026-10-11: "every time I tap it
    /// makes a jingle sound, waits over a second, and then updates"): the row
    /// is marked considered in the published state BEFORE the request, so it
    /// leaves on the tap; the request runs behind it; a failure puts the row
    /// back and buzzes. One click per tap, no success chime, and no refetch
    /// after a success — twenty taps used to mean twenty chimes and twenty
    /// full reloads, each redrawing the list under the finger. The toolbar
    /// Undo takes a misfire back.
    ///
    /// On the deadlines page's SAFETY NET (native PR E) a consider marks the
    /// row seen and it stays waiting (`consideredByTap`); a seen one's circle
    /// does nothing, so it never gets here.
    func considerSegmentTask(_ task: TaskDTO) {
        guard !pendingSegmentConsiders.contains(task.id), let before = segmentRow(task.id),
              before.isConsiderable
        else { return }
        pendingSegmentConsiders.insert(task.id)
        editSegmentRow(task.id) { $0.consideredByTap() }
        WatchCache.editSegmentRow(taskId: task.id) { $0.consideredByTap() }
        WKInterfaceDevice.current().play(.click)
        Task {
            do {
                try await api.considerSegmentTasks(ids: [task.id])
                pendingSegmentConsiders.remove(task.id)
                noteOwnAction()
            } catch {
                pendingSegmentConsiders.remove(task.id)
                editSegmentRow(task.id) { _ in before }
                WatchCache.editSegmentRow(taskId: task.id) { _ in before }
                WKInterfaceDevice.current().play(.failure)
                await refreshReminders()
            }
            WidgetCenter.shared.reloadTimelines(ofKind: WatchWidgetState.kind)
        }
    }

    /// The checkbox: done — the ordinary completion (`markDone`), the row
    /// LEAVES its segment handled (native PR E, `?handled=1`): drawn as the
    /// server sends it back, a considered row "· done", so the segment's "N
    /// of M" never shrinks.
    func completeSegmentTask(_ task: TaskDTO) {
        // Instant like a consider: the row leaves on the tap, a failure
        // reloads it back from the server.
        editSegmentRow(task.id) { $0.left == nil ? $0.leaving(.done) : $0 }
        WatchCache.editSegmentRow(taskId: task.id) { $0.left == nil ? $0.leaving(.done) : $0 }
        WKInterfaceDevice.current().play(.click)
        Task {
            do {
                try await api.markDone(taskId: task.id)
                noteOwnAction()
                WidgetCenter.shared.reloadAllTimelines()
            } catch {
                WKInterfaceDevice.current().play(.failure)
                await load()
            }
        }
    }

    /// Defer all: every row still waiting in `segment` goes to tomorrow —
    /// not a consider (amendment 9). One server undo entry.
    func deferSegment(_ segment: TaskSegmentDTO) {
        let ids = segment.waitingTasks.map(\.id)
        guard !ids.isEmpty else { return }
        ids.forEach { setSegmentRow($0, state: .deferred) }
        WKInterfaceDevice.current().play(.click)
        Task {
            do {
                try await api.deferSegmentTasks(ids: ids)
                ids.forEach { WatchCache.setSegmentRow(taskId: $0, state: .deferred) }
                noteOwnAction()
                // The click was the feedback; no success chime (2026-10-11).
                WidgetCenter.shared.reloadTimelines(ofKind: WatchWidgetState.kind)
            } catch {
                WKInterfaceDevice.current().play(.failure)
            }
            await refreshReminders()
        }
    }

    // MARK: - Quota prompts (quota reminders, 2026-09-24)

    /// Prompt actions whose server round trip is still in flight,
    /// `prompt_key -> did`. Drawn over every reminders payload
    /// (`overlayingPendingPrompts`) — including one `load()` fetched while
    /// the action was on the wire — so tapping through several prompts
    /// quickly never flashes an already-tapped one back. Each key leaves the
    /// map when its own response lands, success or failure, BEFORE the
    /// reconciling `load()`.
    private var pendingPromptActions: [String: Bool] = [:]

    private func overlayingPendingPrompts(_ groups: [ReminderGroupDTO]) -> [ReminderGroupDTO] {
        guard !pendingPromptActions.isEmpty else { return groups }
        return groups.map { group in
            group.replacingPrompts(group.prompts.map { prompt in
                guard let did = pendingPromptActions[prompt.promptKey], prompt.isWaiting else { return prompt }
                return prompt.handled(did: did)
            })
        }
    }

    /// A quota PROMPT on the Reminders page: tap = CONSIDERED (the circle —
    /// handled for today, nothing logged), the square = DID IT (+1 and
    /// considered). Keyed by `prompt_key`: a daily quota's prompts in
    /// different slots share one task id.
    ///
    /// Optimistic like `completeReminder` (the prompt is drawn handled at
    /// once, so it leaves the list), then SERVER-TRUE like `logQuota`: the
    /// quotas the endpoint returns are written into `tasks`/`WatchCache`
    /// through the same `settleConfirmedQuotas` step `settleQuota` uses, so
    /// the Quotas page shows the server's count, and `load()`'s
    /// fetch-started-before-the-tap rule keeps a racing fetch from putting
    /// the old count back. Then `load()` re-fetches the reminders — a prompt's
    /// state is the server's to compute (a did-it on Piano Scales #1 can finish
    /// #2 in another slot).
    func actOnPrompt(_ prompt: QuotaPromptDTO, did: Bool) {
        guard prompt.isWaiting, pendingPromptActions[prompt.promptKey] == nil else { return }
        pendingPromptActions[prompt.promptKey] = did
        reminderGroups = overlayingPendingPrompts(reminderGroups)
        WKInterfaceDevice.current().play(.click)

        Task {
            do {
                let result = did
                    ? try await api.didPrompts(keys: [prompt.promptKey], source: .watch)
                    : try await api.considerPrompts(keys: [prompt.promptKey])
                settleConfirmedQuotas(result.tasks)
                // The click was the feedback; no success chime (2026-10-11).
                noteOwnAction()
                WidgetCenter.shared.reloadAllTimelines()
            } catch {
                // Most likely a key from before midnight (the server refuses
                // another day's key) — the reload below fetches today's.
                WKInterfaceDevice.current().play(.failure)
            }
            pendingPromptActions.removeValue(forKey: prompt.promptKey)
            await load()
        }
    }

    /// The periods a prompt can be moved to — every slot, in start order
    /// (the server sends one group per slot, already ordered, plus the
    /// un-slotted group last, which has no slot and is skipped).
    var promptPeriods: [TimeSlotDTO] { reminderGroups.compactMap(\.slot) }

    /// Whether a prompt can be moved from here. A DAILY row (it has a
    /// `number`) needs the server's `numbers` to know which of the quota's
    /// numbers it stands for; a server that predates that field would make
    /// the move fall through to `slot_id` and drag every number along, so
    /// such a row offers no list rather than the wrong move.
    func canMove(_ prompt: QuotaPromptDTO) -> Bool {
        !promptPeriods.isEmpty && (prompt.number == nil || prompt.numbers != nil)
    }

    /// Move a quota PROMPT to another period for good (2026-09-25, the
    /// press-and-hold list on the Reminders page). The web quota editor's
    /// own write: read the quota's stored `quota_prompt_config`, merge the
    /// move over it (`WatchPromptMove` — a daily row moves only its own
    /// numbers), `PATCH /api/tasks/{id}` (one server undo entry, so the
    /// toolbar Undo takes it back). Not optimistic — the row belongs to
    /// another slot afterwards, and `load()` puts it there from the server's
    /// answer; the line under the header says where it went meanwhile.
    /// `currentSlotId` is where the row is drawn now (the server's `slot_id`,
    /// else its group's slot); a "move" there is no move at all.
    func movePrompt(_ prompt: QuotaPromptDTO, from currentSlotId: Int?, to slot: TimeSlotDTO) {
        guard canMove(prompt), currentSlotId != slot.id else { return }
        WKInterfaceDevice.current().play(.click)
        Task {
            do {
                let stored = try await api.fetchQuotaPromptConfig(taskId: prompt.taskId)
                let config = WatchPromptMove.movedConfig(
                    stored: stored, numbers: prompt.numbers, toSlotId: slot.id
                )
                try await api.setQuotaPromptConfig(taskId: prompt.taskId, config: config)
                // The tap's click was the feedback (no success chime, 2026-10-11).
                noteOwnAction()
                let note = "Moved to \(slot.label)"
                lastActionDescription = note
                WidgetCenter.shared.reloadAllTimelines()
                await load()
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if lastActionDescription == note { lastActionDescription = nil }
            } catch {
                WKInterfaceDevice.current().play(.failure)
                await load()
            }
        }
    }

    /// Re-fetch ONLY the reminders payload — after a Quotas-page `+1`/`−1`,
    /// whose quota's prompts (count, and whether still waiting today) live
    /// in it. Not a full `load()`: that refetches `/api/tasks` too, which
    /// the Quotas page deliberately avoids after each tap (see `logQuota`).
    private func refreshReminders() async {
        guard let payload = try? await api.fetchReminders() else { return }
        reminderGroups = overlayingPendingPrompts(payload.groups)
        WatchCache.saveReminders(payload.groups)
        taskSegments = payload.taskSegments
        WatchCache.saveTaskSegments(payload.taskSegments)
    }

    // MARK: - Tasks

    func completeTask(_ task: TaskDTO) {
        tasks.removeAll { $0.id == task.id }
        WKInterfaceDevice.current().play(.click)

        Task {
            do {
                try await api.markDone(taskId: task.id)
                // No success chime (Trent, 2026-10-11): the tap's single
                // click is the whole feedback, as on a segment row; only a
                // failure buzzes.
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
                // The tap's click was the feedback (no success chime, 2026-10-11).
                noteOwnAction()
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
        // One click for +1 and −1 alike (2026-10-11: every successful tap is
        // the single click; only a failure buzzes).
        WKInterfaceDevice.current().play(.click)

        Task {
            do {
                let confirmed = try await api.logProgress(taskId: task.id, delta: delta, source: .watch)
                settleQuota(task.id, delta: delta, confirmed: confirmed)
                // The tap's click was the feedback (no success chime, 2026-10-11).
                noteOwnAction()
                WidgetCenter.shared.reloadAllTimelines()
                // Logged, but the body didn't decode: nothing trustworthy to
                // draw, so fetch the truth.
                if confirmed == nil {
                    await load()
                } else {
                    // This quota's prompts on the Reminders page carry its
                    // count and whether it still waits today (quota
                    // reminders, 2026-09-24) — server-computed, so fetch.
                    await refreshReminders()
                }
            } catch {
                // Usually nothing changed server-side and `tasks` still holds
                // the pre-tap count, so retiring the delta is the revert. But
                // a timeout can fire after the server committed, so fetch the
                // truth either way — `load()` re-fetches the reminders (and
                // this quota's prompts) too.
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
        if let confirmed { settleConfirmedQuotas([confirmed]) }
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

    /// Write quotas AS THE SERVER RETURNED THEM into `tasks` and
    /// `WatchCache`, and note when (`settledAt`) so a `load()` that started
    /// earlier keeps these counts rather than its own older ones. The one
    /// write path for a `+1`/`−1` response (`settleQuota`) and a prompt
    /// action's `tasks` (`actOnPrompt`) — so both stay server-true the same
    /// way. A quota not in `tasks` is left for the next fetch.
    private func settleConfirmedQuotas(_ confirmed: [TaskDTO]) {
        var wrote = false
        for task in confirmed {
            guard let idx = tasks.firstIndex(where: { $0.id == task.id }) else { continue }
            tasks[idx] = task
            settleCounter += 1
            settledAt[task.id] = settleCounter
            wrote = true
        }
        if wrote { WatchCache.saveTasks(tasks, projects: projects) }
    }

    // MARK: - Bulk overdue

    /// Snooze every overdue task (server-side set, not just what's on
    /// screen) to the next period or by +1 hour. P3 (High) is only included
    /// once nothing lower is left in the sweep, P4 (Urgent) never — see
    /// `bulkSnooze()` / `docs/TASK-MODEL.md`'s due-date philosophy. Same
    /// endpoint the notification "All → Next period" action and the phone's
    /// clock button use.
    ///
    /// `async`, returning the server's real result (`nil` on failure) rather
    /// than firing-and-forgetting internally — `BulkSnoozeSheetView` awaits
    /// this so it can show what actually happened (N snoozed, High included,
    /// High or Urgent still overdue) instead of just closing on tap and hoping.
    @discardableResult
    func bulkSnoozeOverdue(_ target: TaskSnoozeTarget) async -> APIClient.BulkSnoozeResult? {
        WKInterfaceDevice.current().play(.click)
        do {
            let result = switch target {
            // `notify: false`: the sheet shows the result itself, so the server's
            // feedback push would repeat it (src/core/notifications/sweep-feedback.ts).
            case .nextPeriod: try await api.snoozeOverdue(slot: "next", notify: false)
            case .plusOneHour: try await api.snoozeOverdue(deltaMinutes: 60, notify: false)
            }
            // The click was the feedback; a sweep that moved nothing buzzes.
            if result.tasksAffected == 0 { WKInterfaceDevice.current().play(.failure) }
            // The moved tasks' banners on the watch, and only theirs.
            await dismissNotificationsAfterSweep(result)
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

    /// Recompute `canUndo` from the scope (`UndoScope.canUndo`).
    private func refreshUndo() {
        canUndo = WatchCache.undoScope.canUndo(legacyUndoable: legacyUndoable)
    }

    /// A tap of this app's landed: its `undo_id` is already in the scope
    /// (`APIClient.undoRecorder` records it before the call returns), so this
    /// only redraws the button — and, against an older server, counts the
    /// new entry the way the counts would.
    private func noteOwnAction() {
        if !WatchCache.undoScope.scoped { legacyUndoable = max(legacyUndoable, 0) + 1 }
        refreshUndo()
    }

    /// The toolbar Undo (scoped since 2026-10-26, `UndoScope`): only the
    /// watch's OWN last action — a tap here or on the Smart Stack card —
    /// sent by its id (`POST /api/undo { id }`). The server refuses (409)
    /// when anything newer happened anywhere: nothing is undone, the button
    /// goes disabled and the header says "Changed elsewhere — can't undo".
    /// Against an older server, the bare `/api/undo` ("whatever changed
    /// last", the phone widgets' old rule).
    func undo() {
        guard canUndo else { return }
        WKInterfaceDevice.current().play(.click)
        Task {
            do {
                let scope = WatchCache.undoScope
                let result: APIClient.UndoRedoResult
                if scope.scoped {
                    guard let id = scope.undoTarget else {
                        await showChangedElsewhere()
                        return
                    }
                    switch try await api.undo(id: id) {
                    case .done(let done):
                        WatchCache.updateUndoScope { $0.undid(done.actedId ?? id) }
                        result = done
                    case .conflict(let reason, let newest):
                        WatchCache.updateUndoScope { $0.undoConflict(id: id, reason: reason, newest: newest) }
                        await showChangedElsewhere()
                        return
                    }
                } else {
                    result = try await api.undoLastAction()
                    legacyUndoable = result.undoableCount
                }
                let note = "Undid: \(result.description)"
                lastActionDescription = note
                refreshUndo()
                // The tap's click was the feedback (no success chime, 2026-10-11).
                WidgetCenter.shared.reloadAllTimelines()
                // Also fetches the undo status: the scope's next own id is
                // offered once the server says it is the newest entry.
                await load()
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if lastActionDescription == note { lastActionDescription = nil }
            } catch {
                WKInterfaceDevice.current().play(.failure)
            }
        }
    }

    /// A stale Undo: the failure buzz, the button disabled from the updated
    /// scope, "Changed elsewhere — can't undo" under the header for a few
    /// seconds, and a fetch — something changed elsewhere.
    private func showChangedElsewhere() async {
        WKInterfaceDevice.current().play(.failure)
        refreshUndo()
        let note = UndoScope.changedElsewhere
        lastActionDescription = note
        await load()
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        if lastActionDescription == note { lastActionDescription = nil }
    }
}

#if DEBUG
extension WatchViewModel {
    /// A model pre-filled with `WatchPreviewData` (realistic sample quotas) for
    /// `#Preview`s — no network, `hasLoadedOnce` already true so the page
    /// renders content instead of its first-launch spinner. Lives in this
    /// file because the properties it fills are `private(set)`. Setting
    /// `showMetQuotas` persists through its `didSet`, which is harmless in a
    /// preview process (its App Group defaults are its own sandbox).
    /// `only`: keep just the quotas it accepts (the interval-quota preview).
    static func preview(
        showMet: Bool, takeback: Bool = false, only: ((TaskDTO) -> Bool)? = nil
    ) -> WatchViewModel {
        let model = WatchViewModel()
        model.tasks = WatchPreviewData.quotas.filter { only?($0) ?? true }
        model.labelConfig = WatchPreviewData.labelConfig
        model.hasLoadedOnce = true
        model.canUndo = true
        model.showMetQuotas = showMet
        model.quotasTakebackMode = takeback
        return model
    }

    /// The Tasks page with the row-corner sample (`WatchPreviewData.cornerTasks`).
    static func previewTasks(_ tasks: [TaskDTO] = WatchPreviewData.cornerTasks) -> WatchViewModel {
        let model = WatchViewModel()
        model.tasks = tasks
        model.projects = WatchPreviewData.cornerProjects
        model.hasLoadedOnce = true
        model.canUndo = true
        return model
    }

    /// The Reminders page with the sample Early morning prompts, the slot
    /// pinned to Early morning (`slotOverride`) so the preview doesn't
    /// depend on the clock.
    static func previewReminders(handled: [String: Bool] = [:], segments: Bool = false) -> WatchViewModel {
        let model = WatchViewModel()
        model.reminderGroups = WatchPreviewData.reminderGroups(handled: handled)
        model.taskSegments = segments ? WatchPreviewData.taskSegments : []
        model.slotOverride = 0
        model.hasLoadedOnce = true
        model.canUndo = true
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
