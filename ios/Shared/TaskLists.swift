import Foundation

/// Which open tasks count as "overdue" / "due today", and in what order —
/// shared by the Tasks widget (`TasksTimeline`) and the Mac menu bar item
/// (`MenuBarModel`), so the widget's Overdue page and the menu bar's badge
/// never disagree about what is overdue.
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

    /// Most overdue first: the server's own due-candidate order
    /// (`fetchDueCandidates`' `ORDER BY due_at ASC`) and §4.5's stale-first
    /// rule — the oldest debt is the one most likely to have been forgotten.
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

    /// How many tasks `POST /api/tasks/bulk/snooze-overdue` would move right
    /// now — an honest client-side ESTIMATE of `filterForBulkSnooze`'s ceiling
    /// rule (`src/core/tasks/bulk.ts`): P0-P2 always; P3 (High) only once none
    /// of P0-P2 remain; P4 (Urgent) never. See `TasksTimeline.
    /// overdueSweepEligibleCount`'s doc for the two gaps versus the server.
    static func overdueSweepEligibleCount(_ tasks: [TaskDTO], now: Date = Date()) -> Int {
        let overdue = eligible(tasks).filter { $0.isOverdue(now: now) }
        let lowCount = overdue.filter { $0.priority < 3 }.count
        if lowCount > 0 { return lowCount }
        return overdue.filter { $0.priority == 3 }.count
    }
}
