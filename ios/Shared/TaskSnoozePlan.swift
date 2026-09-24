import Foundation

// MARK: - Snooze targets (per-task "Next period" / "+1h")
//
// Shared (2026-09-24) by the phone Tasks widget's snooze mode / bulk select
// (`OpenTaskWidgets/WidgetIntents.swift`) and the watch Tasks page's
// touch-and-hold snooze (`OpenTaskWatch/WatchViewModel.snoozeTask`). It
// lived in `OpenTaskWidgets/TaskFeed.swift` until the watch needed the same
// due-relative rule — moved here, not copied, so the two surfaces can't
// drift. Pure Foundation + `DateHelpers`/`TimeSlotStore`/`APIClient`, all of
// which every target that compiles `ios/Shared/` already has.

/// A per-task snooze target: "next period" (⏭) or "+1h". What each one
/// MEANS for a given task is `TaskSnoozePlan`'s job — the "All overdue" bar
/// (`SnoozeAllOverdueIntent`, and the watch's bulk sheet) uses the same two
/// ideas but hands them to the server's own sweep instead, where every task
/// is overdue by definition.
enum TaskSnoozeTarget: String {
    case nextPeriod = "next"
    case plusOneHour = "1h"
}

/// Where a per-row or bulk-select snooze sends each task, and how that
/// becomes `POST /api/tasks/bulk/snooze` requests. Pure — no store, no
/// network (except `send`, below) — so the rules can be exercised outside a
/// widget process (verified 2026-09-24 by compiling this file with
/// `ios/Shared/` into a throwaway `swiftc` harness; there is no Swift test
/// target).
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

    /// Send a plan's requests one after another, returning the ids that
    /// actually moved (every id of each request that succeeded). Sequential
    /// on purpose: each request is its own server undo entry, and firing
    /// them concurrently would make the order they land on the undo stack —
    /// and so which one the first Undo reverses — a race. A failed request
    /// doesn't stop the rest: its ids simply aren't in the result, so a
    /// caller can keep exactly those for a retry without re-moving the
    /// others (an upcoming task's +1h is a delta — sent twice, it would land
    /// two hours later).
    ///
    /// `include_task_ids` mirrors each request's ids: an explicit,
    /// deliberate tap on a task always bypasses the P3/P4 sweep-safety
    /// filter — the web's own convention (`src/lib/save-quick-panel-changes.ts`).
    ///
    /// `afterEach` runs once per request that succeeded (the phone widget
    /// bumps its local undo count there — one server undo entry each).
    static func send(
        _ requests: [Request],
        afterEach: (Request) -> Void = { _ in }
    ) async -> Set<Int> {
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
                afterEach(request)
            } catch {
                print("[OpenTask] Snooze \(request.ids) failed: \(error)")
            }
        }
        return moved
    }
}
