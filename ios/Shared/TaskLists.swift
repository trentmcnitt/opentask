import Foundation

/// Which open tasks count as "overdue" / "due today" / "up next", and in
/// what order — shared by the Tasks widget (`TasksTimeline`, whose pages
/// forward here) and the Mac menu bar item (`MenuBarModel`), so the widget's
/// Overdue page and the menu bar's badge never disagree about what is overdue.
///
/// Foundation-only (compiled into the widget extensions, the apps and
/// `OpenTaskLogicTests`).
enum TaskLists {

    /// The three exclusions every task list shares, each with its own home:
    ///
    /// - **Undated** tasks: §7.1 treats a task without a real due date as
    ///   backlog, and putting backlog on a today/up-next surface is exactly
    ///   the noise the redesign is removing.
    /// - **Reminders** (§6): their own widget, their own no-debt semantics.
    /// - **Tracked** items, `progress_target > 1` (§8 as amended 2026-07-27):
    ///   their own widget too. A quota row inside a task list buries the thing
    ///   being glanced at — it answers a different question ("how far in",
    ///   not "is it done").
    static func eligible(_ tasks: [TaskDTO]) -> [TaskDTO] {
        tasks.filter { !$0.isReminder && !$0.isTracked && $0.dueDate != nil }
    }

    static func sortedSoonestFirst(_ tasks: [TaskDTO]) -> [TaskDTO] {
        tasks.sorted { lhs, rhs in
            let l = lhs.dueDate ?? .distantFuture
            let r = rhs.dueDate ?? .distantFuture
            // Soonest (so: most overdue) first; priority breaks ties.
            if l != r { return l < r }
            return lhs.priority > rhs.priority
        }
    }

    /// Every eligible task whose due time has passed, by
    /// `TaskDTO.isOverdue(now:)` — the same test every row's red time uses.
    ///
    /// That is the web dashboard's Overdue chip exactly (`classifyTaskDueDate`
    /// in `DueDateFilterBar.tsx`: `due_at < now` over the dashboard's list,
    /// which drops reminders and quotas the same way), so the Tasks widget's
    /// Overdue header count is the count the chip shows when the header link
    /// opens the dashboard filtered to it (`/?filter=overdue`). It is the
    /// server badge's set (`getCurrentlyDueTaskIds`, `?overdue=true`) for
    /// every task with a `due_at`, recurring ones included; the one gap is a
    /// recurring task with NO `due_at` whose schedule fell earlier today,
    /// which the badge derives from its rrule and nothing client-side can —
    /// the same accepted gap `overdueSweepEligibleCount`'s doc describes. A
    /// second fetch of `?overdue=true` to close it is ruled out for the widget
    /// (one `/api/tasks` read, shared with Quotas — ios/AGENTS.md "Data").
    ///
    /// Most overdue first: the server's own due-candidate order
    /// (`fetchDueCandidates`' `ORDER BY due_at ASC`) and §4.5's stale-first
    /// rule — the oldest debt is the one most likely to have been forgotten,
    /// so it is the one a first page must not bury.
    static func overdue(_ tasks: [TaskDTO], now: Date = Date()) -> [TaskDTO] {
        sortedSoonestFirst(eligible(tasks).filter { $0.isOverdue(now: now) })
    }

    /// Due or overdue by the end of the local day.
    static func dueToday(_ tasks: [TaskDTO], now: Date = Date()) -> [TaskDTO] {
        let calendar = Calendar.current
        guard let endOfDay = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) else {
            return []
        }
        return sortedSoonestFirst(eligible(tasks).filter { ($0.dueDate ?? .distantFuture) < endOfDay })
    }

    /// Every eligible task, soonest (most overdue) first, with NO end-of-day
    /// cutoff — `dueToday` without its cutoff.
    static func upNext(_ tasks: [TaskDTO]) -> [TaskDTO] {
        sortedSoonestFirst(eligible(tasks))
    }

    /// How many tasks `POST /api/tasks/bulk/snooze-overdue` would actually
    /// move right now — an HONEST CLIENT-SIDE ESTIMATE, not an authoritative
    /// count. Mirrors `filterForBulkSnooze`'s ceiling rule
    /// (`src/core/tasks/bulk.ts`): P0-P2 always eligible; P3 (High) joins in
    /// ONLY once none of P0-P2 remain in the overdue-and-snoozable set; P4
    /// (Urgent) never counts. `tasks` should be the FULL open-tasks cache
    /// (unscoped) — the sweep acts server-wide, not on whatever scope/page
    /// happens to be on screen.
    ///
    /// Two honest gaps versus the server, both accepted rather than chased:
    /// (1) "overdue" here is `TaskDTO.isOverdue(now:)` (`due_at < now`), the
    /// SAME check every row's red styling already uses — the server's actual
    /// sweep instead queries `getCurrentlyDueTaskIds` (§4.6: a recurring
    /// task's frozen `due_at` needs its own "is this actually due today"
    /// logic that a raw date comparison can't replicate client-side without
    /// a dedicated endpoint the native clients' API surface doesn't have).
    /// (2) `eligible` already drops reminders/tracked items, matching
    /// `filterForBulkSnooze`'s own "reminders and quotas are never late"
    /// exclusion — no separate filter needed here. Both gaps only ever
    /// affect what number a sweep bar PRINTS and whether it shows at all
    /// (N > 0); the server remains the sole authority on what actually moves
    /// when the button is tapped.
    static func overdueSweepEligibleCount(_ tasks: [TaskDTO], now: Date = Date()) -> Int {
        let overdue = eligible(tasks).filter { $0.isOverdue(now: now) }
        let lowCount = overdue.filter { $0.priority < 3 }.count
        if lowCount > 0 { return lowCount }
        return overdue.filter { $0.priority == 3 }.count
    }
}
