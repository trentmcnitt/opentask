import Foundation

// Foundation-only on purpose (2026-09-25, the Overdue scope): the Tasks
// widget's list rules and its scope ring/default live here, apart from the
// SwiftUI entry/provider in TasksWidget.swift, so the macOS logic-test bundle
// (`OpenTaskLogicTests`, ios/CLAUDE.md § Tests) can compile and test them.

// MARK: - Today's set

/// The "what counts as today" rule, plus scope handling.
///
/// The server has no today endpoint — the dashboard fetches the open set from
/// `GET /api/tasks` and buckets client-side — so the widget applies the same
/// rule here rather than inventing an endpoint.
enum TasksTimeline {

    /// The three exclusions both unified pages share, each with its own home:
    ///
    /// - **Undated** tasks: §7.1 treats a task without a real due date as
    ///   backlog, and putting backlog on a today/up-next surface is exactly
    ///   the noise the redesign is removing.
    /// - **Reminders** (§6): their own widget, their own no-debt semantics.
    /// - **Tracked** items, `progress_target > 1` (§8 as amended 2026-07-27):
    ///   their own widget too. A quota row inside a task list buries the thing
    ///   being glanced at — it is twice the height of a task row and answers a
    ///   different question ("how far in", not "is it done").
    private static func eligibleTasks(from tasks: [TaskDTO]) -> [TaskDTO] {
        tasks.filter { !$0.isReminder && !$0.isTracked && $0.dueDate != nil }
    }

    private static func sortedSoonestFirst(_ tasks: [TaskDTO]) -> [TaskDTO] {
        tasks.sorted { lhs, rhs in
            let l = lhs.dueDate ?? .distantFuture
            let r = rhs.dueDate ?? .distantFuture
            // Soonest (so: most overdue) first; priority breaks ties.
            if l != r { return l < r }
            return lhs.priority > rhs.priority
        }
    }

    /// How many tasks `POST /api/tasks/bulk/snooze-overdue` would actually
    /// move right now (2026-09-23, Phase 2's "All overdue" snooze-mode bar)
    /// — an HONEST CLIENT-SIDE ESTIMATE, not an authoritative count. Mirrors
    /// `filterForBulkSnooze`'s ceiling rule (`src/core/tasks/bulk.ts`): P0-P2
    /// always eligible; P3 (High) joins in ONLY once none of P0-P2 remain in
    /// the overdue-and-snoozable set; P4 (Urgent) never counts. `tasks`
    /// should be the FULL open-tasks cache (unscoped) — the sweep acts
    /// server-wide, not on whatever scope/page happens to be on screen.
    ///
    /// Two honest gaps versus the server, both accepted rather than chased:
    /// (1) "overdue" here is `TaskDTO.isOverdue(now:)` (`due_at < now`), the
    /// SAME check every row's red styling already uses — the server's actual
    /// sweep instead queries `getCurrentlyDueTaskIds` (§4.6: a recurring
    /// task's frozen `due_at` needs its own "is this actually due today"
    /// logic that a raw date comparison can't replicate client-side without
    /// a dedicated endpoint neither this widget nor its API surface has).
    /// (2) `eligibleTasks` already drops reminders/tracked items, matching
    /// `filterForBulkSnooze`'s own "reminders and quotas are never late"
    /// exclusion — no separate filter needed here. Both gaps only ever
    /// affect what number this bar PRINTS and whether it shows at all
    /// (N > 0); the server remains the sole authority on what actually moves
    /// when the button is tapped.
    static func overdueSweepEligibleCount(from tasks: [TaskDTO], now: Date = Date()) -> Int {
        let overdue = eligibleTasks(from: tasks).filter { $0.isOverdue(now: now) }
        let lowCount = overdue.filter { $0.priority < 3 }.count
        if lowCount > 0 { return lowCount }
        return overdue.filter { $0.priority == 3 }.count
    }

    /// Due or overdue as of the end of the local day — the "Today" unified
    /// page (2026-09-23, item 4) and, unchanged, what every per-project page
    /// still shows.
    static func todaysTasks(from tasks: [TaskDTO], now: Date = Date()) -> [TaskDTO] {
        let calendar = Calendar.current
        guard let endOfDay = calendar.date(
            byAdding: .day, value: 1, to: calendar.startOfDay(for: now)
        ) else {
            return []
        }
        return sortedSoonestFirst(eligibleTasks(from: tasks).filter { ($0.dueDate ?? .distantFuture) < endOfDay })
    }

    /// "Up next" (2026-09-23, item 4) — Trent: "Instead of Up Next I'd also
    /// like to have just a Today one… We need a Today one as well." This is
    /// what "Up next" used to mean before that request split it in two:
    /// every dated open task the widget considers at all, soonest (most
    /// overdue) first, with NO end-of-today cutoff — `eligibleTasks`'
    /// exclusions apply exactly as `todaysTasks` uses them.
    static func upNextTasks(from tasks: [TaskDTO]) -> [TaskDTO] {
        sortedSoonestFirst(eligibleTasks(from: tasks))
    }

    /// Projects that actually have something in TODAY's set, in the order
    /// the server returned them — still the ring `todaysTasks` uses. Per-
    /// project pages are unchanged by item 4 ("Then the per-project pages as
    /// now"), so this stays scoped to `todaysTasks`, not `upNextTasks`.
    ///
    /// Derived entirely from the payload — nothing on the client knows a
    /// project name or how many there are. §7.1 explicitly leaves the project
    /// set open, so any hardcoded list would go stale by design.
    static func scopedProjects(
        tasks: [TaskDTO],
        projects: [ProjectDTO],
        now: Date = Date()
    ) -> [ProjectDTO] {
        let present = Set(todaysTasks(from: tasks, now: now).map(\.projectId))
        return projects.filter { present.contains($0.id) }
    }

    /// The DONE list for "show completed" (2026-09-23) — today's completions,
    /// scoped the same way `todaysTasks`/`upNextTasks` scope the OPEN list:
    /// reminders and tracked items are excluded ALWAYS (their own widgets own
    /// that data — same exclusions `eligibleTasks` applies), and a
    /// per-project page filters further by `project_id`. The unified pages
    /// (Overdue/Today/Up next) show every one of today's matching
    /// completions, unfiltered by project.
    ///
    /// DECISION, not fully spec'd (flagged in the handoff): there is no clean
    /// way to further restrict "Today"'s done list to only tasks that were
    /// DUE today (as opposed to any task completed today) without extra
    /// due-date reconstruction the completions payload doesn't cleanly
    /// support — `CompletionDTO` carries no due date at all. So "Today" here
    /// means "completed today", not "was due today and got done". Sorted
    /// most-recently-completed first — a small, un-spec'd choice: the DONE
    /// section reads top-down like the OPEN list above it, so the item just
    /// checked off appears at its top, not buried under older completions.
    static func doneTasks(from completions: [CompletionDTO], scope: Int) -> [CompletionDTO] {
        // `isQuota`, not the bare `isTracked` flag (2026-09-24): most quotas
        // predate the flag and are quotas by target alone, and a quota's
        // completion (its period rollover) must never be offered for put-back
        // — `POST /api/tasks/:id/undone` refuses quotas.
        let eligible = completions.filter { !$0.isReminder && !$0.isQuota }
        let scoped: [CompletionDTO]
        if isUnifiedScope(scope) {
            scoped = eligible
        } else {
            scoped = eligible.filter { $0.projectId == scope }
        }
        return scoped.sorted { ($0.completedDate ?? .distantPast) > ($1.completedDate ?? .distantPast) }
    }

    /// Whether `scope` is one of the project-less pages — Overdue, Today, Up
    /// next — rather than one project's.
    static func isUnifiedScope(_ scope: Int) -> Bool {
        scope == WidgetStore.overdueScope || scope == WidgetStore.allProjects
            || scope == WidgetStore.upNextScope
    }

    /// Filters to one project's slice of `tasks`. Only ever called with a
    /// real project id now — the unified scopes (`overdueScope`, `allProjects`,
    /// `upNextScope`) are resolved by `TasksProvider.makeEntry` before this
    /// is reached, each from its own source list (`overdueTasks` /
    /// `todaysTasks` / `upNextTasks`), not by a no-op pass through here.
    static func apply(scope: Int, to tasks: [TaskDTO]) -> [TaskDTO] {
        tasks.filter { $0.projectId == scope }
    }

    /// Due times still ahead of us today. An entry at each one lets a task
    /// visibly tip into overdue at the right minute without spending budget.
    static func upcomingDueDates(in tasks: [TaskDTO], now: Date = Date()) -> [Date] {
        tasks.compactMap(\.dueDate).filter { $0 > now }.sorted()
    }

    // MARK: Overdue (2026-09-25)

    /// The "Overdue" page — Trent: "if things are overdue, I'd like that to be
    /// the default widget screen for the tasks." Every eligible task (dated,
    /// not a reminder, not a quota — `eligibleTasks`) whose due time has
    /// passed, by `TaskDTO.isOverdue(now:)`, the same test every row's red
    /// time already uses.
    ///
    /// That is the web dashboard's Overdue chip exactly (`classifyTaskDueDate`
    /// in `DueDateFilterBar.tsx`: `due_at < now` over the dashboard's list,
    /// which drops reminders and quotas the same way), so the header's count
    /// is the count the chip shows when the header link opens the dashboard
    /// filtered to it (`/?filter=overdue`). It is the server badge's set
    /// (`getCurrentlyDueTaskIds`, `?overdue=true`) for every task with a
    /// `due_at`, recurring ones included; the one gap is a recurring task
    /// with NO `due_at` whose schedule fell earlier today, which the badge
    /// derives from its rrule and nothing client-side can — the same accepted
    /// gap `overdueSweepEligibleCount`'s doc describes. A second fetch of
    /// `?overdue=true` to close it is ruled out (one `/api/tasks` read, shared
    /// with Quotas — ios/CLAUDE.md "Data").
    ///
    /// Most overdue first: the order every other Tasks page uses
    /// (`sortedSoonestFirst`), the server's own due-candidate order
    /// (`fetchDueCandidates`' `ORDER BY due_at ASC`), and §4.5's stale-first
    /// rule — the oldest debt is the one most likely to have been forgotten,
    /// so it is the one the first page must not bury.
    static func overdueTasks(from tasks: [TaskDTO], now: Date = Date()) -> [TaskDTO] {
        sortedSoonestFirst(eligibleTasks(from: tasks).filter { $0.isOverdue(now: now) })
    }

    /// The page the widget opens on when the user hasn't chosen one (or their
    /// choice has lapsed — see `resolveScope`): Overdue while anything is
    /// overdue, else Today, which is what it always was.
    static func naturalScope(overdueCount: Int) -> Int {
        overdueCount > 0 ? WidgetStore.overdueScope : WidgetStore.allProjects
    }

    /// The chevrons' ring, in order: Overdue (only while something is — no
    /// page for nothing, Trent's "no chrome for something that isn't there"),
    /// Today, Up next, then every project with something due today.
    ///
    /// The ONE place the ring is built: `ShiftProjectScopeIntent` cycles it
    /// and `resolveScope` checks a stored choice against it, and two copies
    /// would drift on the first change.
    static func scopeRing(tasks: [TaskDTO], projects: [ProjectDTO], now: Date = Date()) -> [Int] {
        let overdue = overdueTasks(from: tasks, now: now).isEmpty ? [] : [WidgetStore.overdueScope]
        return overdue + [WidgetStore.allProjects, WidgetStore.upNextScope]
            + scopedProjects(tasks: tasks, projects: projects, now: now).map(\.id)
    }

    /// Which page to show: the user's chevron choice while it still holds,
    /// else the natural default.
    ///
    /// A choice is paired with the natural default it was made against
    /// (`WidgetStore.TasksScopeChoice`) — the Reminders slot override's
    /// self-expiring trick. While the natural default is unchanged the choice
    /// is honored ("I chevroned to Up next, leave me there"); the moment it
    /// changes — overdue appears, so the default becomes Overdue, or the last
    /// overdue task is done or snoozed, so it drops back to Today — the choice
    /// lapses and the new default shows, with no timer or reset anywhere.
    /// A choice no longer in the ring (a project with nothing due today any
    /// more, or Overdue once nothing is) lapses too, rather than stranding
    /// the widget on an empty page it can only escape by chevroning.
    static func resolveScope(choice: WidgetStore.TasksScopeChoice?, natural: Int, ring: [Int]) -> Int {
        guard let choice, choice.naturalScope == natural, ring.contains(choice.scope) else {
            return natural
        }
        return choice.scope
    }

    /// Everything `resolveScope` needs, from one set of tasks — the scope on
    /// screen, the ring around it, and the natural default the ring's
    /// chevrons should anchor a new choice to.
    struct ScopeState: Equatable {
        let scope: Int
        let ring: [Int]
        let natural: Int
    }

    static func scopeState(tasks: [TaskDTO], projects: [ProjectDTO], now: Date = Date()) -> ScopeState {
        let ring = scopeRing(tasks: tasks, projects: projects, now: now)
        let natural = naturalScope(overdueCount: overdueTasks(from: tasks, now: now).count)
        let scope = resolveScope(choice: WidgetStore.tasksScopeChoice(), natural: natural, ring: ring)
        return ScopeState(scope: scope, ring: ring, natural: natural)
    }

    /// The scope on screen right now, for the intents that key state by it
    /// (the page, the bulk-select picks, the chevrons). Built from the same
    /// cache the provider's interaction fast path repaints from, with the
    /// same completion tombstones applied (`WidgetStore.filterPending`), so
    /// an intent and the render it triggers agree on the page — including
    /// the tap that checks off the last overdue task and drops the widget
    /// back to Today.
    static func currentScopeState(now: Date = Date()) -> ScopeState? {
        guard let cache = WidgetStore.loadTasks()?.value else { return nil }
        return scopeState(tasks: WidgetStore.filterPending(cache.tasks, now: now), projects: cache.projects, now: now)
    }

    /// `currentScopeState`'s scope, or Today before any payload was cached.
    static func currentScope(now: Date = Date()) -> Int {
        currentScopeState(now: now)?.scope ?? WidgetStore.allProjects
    }
}

