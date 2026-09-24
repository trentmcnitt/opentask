import Foundation

/// The one `GET /api/tasks?done=false` (+ `/api/projects`) read, shared by the
/// Tasks and Track widgets.
///
/// Both kinds render different slices of the *same* payload — today's dated
/// work (§7.1) vs. §5's quotas — so exactly one place fetches it, caches it,
/// falls back to the cache, and applies the §8 optimistic staging. Two copies
/// of that sequence would drift apart on the first fix, and a second fetch of
/// the same endpoint would spend two widgets' refresh budgets on identical
/// bytes. Sharing it means a refresh of *either* kind warms the cache both read
/// from, which is strictly more coverage per reload than either had alone.
///
/// Projects are fetched even though Track ignores them: the App Group cache has
/// one shape (`WidgetStore.saveTasks(_:projects:)`), and a Track-only refresh
/// that wrote an empty project list would blank the Tasks widget's chevron ring
/// until the next Tasks refresh. The extra request is concurrent with the tasks
/// one, so it costs latency only if it is the slower of the two.
enum TaskFeed {

    /// A resolved payload: what to draw, and how honest it is.
    struct Snapshot {
        /// Tombstoned completions removed, staged `+1`s applied (§8).
        let tasks: [TaskDTO]
        let projects: [ProjectDTO]
        /// Today's completions (2026-09-23, "show completed" — the Tasks
        /// widget's DONE list), pending restores filtered out. ALWAYS
        /// fetched, never gated on the toggle — see `snapshot(now:)`'s doc
        /// for why gating it would leave the DONE list empty for one repaint
        /// after the toggle turns on.
        let completions: [CompletionDTO]
        /// Non-nil when this came from the cache because the fetch failed —
        /// drives the "as of HH:MM" note.
        let staleSince: Date?
        /// No server URL / token in the Keychain — the app is not set up.
        let isSignedOut: Bool
    }

    /// Never throws to the caller: a widget's only honest failure modes are
    /// "signed out" and "stale".
    static func snapshot(now: Date = Date()) async -> Snapshot {
        guard APIClient.shared.isConfigured else {
            return Snapshot(tasks: [], projects: [], completions: [], staleSince: nil, isSignedOut: true)
        }

        // Interaction fast path (§8 optimistic check-off): a tap landed seconds
        // ago, so repaint straight from cache — waiting on the network here is
        // exactly what makes a widget button read as dead. No staleness note:
        // this data is seconds old by construction. Not "a tap was recent"
        // alone (2026-09-24): also "no intent has since declared this cache
        // stale" — see `WidgetStore.canRepaintTasksFromCache`.
        if WidgetStore.canRepaintTasksFromCache(now: now), let cached = WidgetStore.loadTasks() {
            return staged(
                cached.value.tasks, cached.value.projects, cached.value.completions,
                staleSince: nil, now: now
            )
        }

        do {
            async let tasks = APIClient.shared.fetchOpenTasks()
            async let projects = APIClient.shared.fetchProjects()
            // Piggybacked undo/redo counts (2026-09-23) — see
            // `RemindersProvider`'s identical block for why this rides along
            // rather than being its own fetch, and why it's `try?`: a flaky
            // `/api/undo/status` must never fail the tasks/projects fetch
            // both Tasks and Track render from.
            async let undoStatus: APIClient.UndoStatus? = try? APIClient.shared.fetchUndoStatus()
            // Today's completions (2026-09-23, "show completed"), same
            // best-effort `try?` reasoning as `undoStatus`: a flaky
            // `/api/completions` must not fail the tasks/projects fetch
            // Track also renders from. Fetched UNCONDITIONALLY (not gated on
            // `WidgetStore.showCompleted`) — see the handoff's reasoning:
            // gating this on the toggle would mean flipping it on hits the
            // interaction fast path above with a cache that never had
            // completions in it, rendering an empty DONE section for the
            // first repaint.
            async let completions: [CompletionDTO]? = try? APIClient.shared.fetchTodaysCompletions(now: now)
            let (fetchedTasks, fetchedProjects, status, fetchedCompletions) =
                try await (tasks, projects, undoStatus, completions)
            let completionsOrEmpty = fetchedCompletions ?? []
            // `now` is when these requests went out — only a fetch sent after
            // a `clearInteraction()` may settle it.
            WidgetStore.saveTasks(
                fetchedTasks, projects: fetchedProjects, completions: completionsOrEmpty, fetchStartedAt: now
            )
            if let status {
                WidgetStore.setUndoRedoCounts(undoable: status.undoableCount, redoable: status.redoableCount)
            }
            return staged(fetchedTasks, fetchedProjects, completionsOrEmpty, staleSince: nil, now: now)
        } catch {
            print("[OpenTaskWidgets] Tasks fetch failed: \(error)")
            guard let cached = WidgetStore.loadTasks() else {
                return Snapshot(tasks: [], projects: [], completions: [], staleSince: nil, isSignedOut: false)
            }
            return staged(
                cached.value.tasks,
                cached.value.projects,
                cached.value.completions,
                staleSince: cached.fetchedAt,
                now: now
            )
        }
    }

    /// Single choke point for the §8 staging, applied on the fresh-fetch path
    /// too: the server may not have committed the interaction yet, and
    /// resurrecting a checked item — or dropping a logged `+1` — for one
    /// refresh cycle looks exactly like the tap didn't take. Also the single
    /// choke point for "show completed"'s pending-restore filtering
    /// (2026-09-23) — the Tasks twin of what `WidgetStore.filterPending(_
    /// groups:)` does for Reminders' `consideredItems`.
    private static func staged(
        _ tasks: [TaskDTO],
        _ projects: [ProjectDTO],
        _ completions: [CompletionDTO],
        staleSince: Date?,
        now: Date
    ) -> Snapshot {
        Snapshot(
            tasks: WidgetStore.applyPendingProgress(
                WidgetStore.filterPending(tasks, now: now),
                now: now
            ),
            projects: projects,
            completions: WidgetStore.filterPendingRestoresFromCompletions(completions, now: now),
            staleSince: staleSince,
            isSignedOut: false
        )
    }

    /// Each id's cached `due_at`, for the snooze intents (2026-09-24): the
    /// same cache the row that was tapped was drawn from, so the target is
    /// computed from the time the user was looking at. An id missing from
    /// the cache comes back undated — it snoozes from now, the one answer
    /// that is right for an overdue task and harmless for anything else.
    static func cachedDueDates(for ids: [Int]) -> [(id: Int, dueAt: Date?)] {
        let tasks = WidgetStore.loadTasks()?.value.tasks ?? []
        let byId = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return ids.map { (id: $0, dueAt: byId[$0]?.dueDate) }
    }
}

// MARK: - Snooze targets (Tasks widget snooze mode / bulk select)

/// A Tasks-widget snooze target: "next period" (⏭) or "+1h". What each one
/// MEANS for a given task is `TaskSnoozePlan`'s job — the "All overdue" bar
/// (`SnoozeAllOverdueIntent`) uses the same two cases but hands them to the
/// server's own sweep instead, where every task is overdue by definition.
/// (Moved here from `WidgetIntents.swift` on 2026-09-24 so the pure plan
/// below compiles without AppIntents.)
enum TaskSnoozeTarget: String {
    case nextPeriod = "next"
    case plusOneHour = "1h"
}

/// Where a per-row or bulk-select snooze sends each task, and how that
/// becomes `POST /api/tasks/bulk/snooze` requests. Pure — no store, no
/// network — so the rules can be exercised outside a widget process
/// (verified 2026-09-24 by compiling this file with `ios/Shared/` into a
/// throwaway `swiftc` harness; there is no Swift test target).
///
/// THE RULE (Trent, 2026-09-24 — replacing 2026-09-23's "one hour from now
/// for everything", which was the wrong instruction): a snooze counts from
/// the task's OWN time while it is still upcoming. Per task, base =
/// `DateHelpers.snoozeBase` = max(now, due), or now when undated:
///
/// - **+1h** — upcoming: exactly due + 60 min (5:00 PM → 6:00 PM), matching
///   the web Quick panel's "+1 hr" increment on a dated task
///   (`QuickActionPanel` → `adjustDate(initWorkingDate(dueAt), 60)`), which
///   adds to the task's own time and never snaps. Overdue/undated: one hour
///   from now, snapped (`snapToNextHour`), matching the web's
///   `computeSnoozeTime('60')` — the dashboard row snooze (`TaskRow.tsx`)
///   and the `bulk/snooze-overdue` sweep. The web has no single "+1h" that
///   does both: its row snooze is always from-now-snapped, its Quick panel
///   increment is always from-the-due-time; this takes each where it is
///   right. See `DateHelpers.snoozePlusOneHour`.
/// - **Next period** — the first time-slot start STRICTLY after base
///   (`TimeSlotStore.nextPeriodStart(slots:after:)`): an 8:30 PM task with
///   no slot left that evening goes to tomorrow's first slot. Overdue and
///   undated tasks count from now, exactly like the sweep's `slot: "next"`.
///
/// REQUESTS, NOT ONE PER TASK: the endpoint takes one `until` for all its
/// ids (or one `delta_minutes`, added to EACH task's own `due_at` —
/// `bulkSnooze`, `src/core/tasks/bulk.ts`), so the plan groups:
///
/// - +1h: every overdue/undated task in ONE `until` request, every upcoming
///   one in ONE `delta_minutes: 60` request (the server's relative mode is
///   exactly "own due + 60" per task, read from the server's `due_at`, so a
///   cache a few seconds stale can't matter). At most two.
/// - Next period: one `until` request per distinct target — bounded by the
///   number of slots (+ tomorrow's first), and one in the common case.
///
/// Each request is its own server undo entry (`logAction` per call), so a
/// selection that spans two groups takes two Undo taps to reverse. ONE
/// entry per gesture would need per-task `until`s on a single endpoint,
/// which none accepts today (`bulk/edit`'s `per_task` is `rrule` only).
enum TaskSnoozePlan {

    struct Request: Equatable {
        enum Kind: Equatable {
            /// Absolute: every id moves to this instant.
            case until(Date)
            /// Relative: every id moves by this much from its own `due_at`.
            case deltaMinutes(Int)
        }
        let kind: Kind
        let ids: [Int]
    }

    /// One task's target, per the rule above. `nil` only for next period
    /// with no usable slots (the ⏭ buttons are disabled in that state).
    static func target(
        _ target: TaskSnoozeTarget, dueAt: Date?, now: Date, slots: [TimeSlotDTO]
    ) -> Date? {
        switch target {
        case .plusOneHour:
            return DateHelpers.snoozePlusOneHour(dueAt: dueAt, now: now)
        case .nextPeriod:
            return TimeSlotStore.nextPeriodStart(
                slots: slots, after: DateHelpers.snoozeBase(dueAt: dueAt, now: now)
            )
        }
    }

    /// The requests that carry `tasks` to their per-task targets, in a
    /// stable order (first-seen group first; ids keep their input order).
    /// Empty when nothing resolves (next period with no slots).
    static func requests(
        _ target: TaskSnoozeTarget,
        tasks: [(id: Int, dueAt: Date?)],
        now: Date,
        slots: [TimeSlotDTO]
    ) -> [Request] {
        switch target {
        case .plusOneHour:
            let isUpcoming: ((id: Int, dueAt: Date?)) -> Bool = { task in
                task.dueAt.map { $0 > now } ?? false
            }
            let fromNow = tasks.filter { !isUpcoming($0) }.map(\.id)
            let upcoming = tasks.filter(isUpcoming).map(\.id)
            var out: [Request] = []
            if !fromNow.isEmpty {
                out.append(Request(kind: .until(DateHelpers.snapToNextHour(now: now)), ids: fromNow))
            }
            if !upcoming.isEmpty {
                out.append(Request(kind: .deltaMinutes(60), ids: upcoming))
            }
            return out
        case .nextPeriod:
            var order: [Date] = []
            var byTarget: [Date: [Int]] = [:]
            for task in tasks {
                guard let until = Self.target(.nextPeriod, dueAt: task.dueAt, now: now, slots: slots) else {
                    continue
                }
                if byTarget[until] == nil { order.append(until) }
                byTarget[until, default: []].append(task.id)
            }
            return order.map { Request(kind: .until($0), ids: byTarget[$0] ?? []) }
        }
    }
}
